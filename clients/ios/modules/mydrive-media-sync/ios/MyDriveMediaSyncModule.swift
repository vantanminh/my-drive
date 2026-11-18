import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import Network
import Photos
import UniformTypeIdentifiers
import WebKit

internal final class ICloudNetworkRequiredException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ICLOUD_NETWORK_REQUIRED" }
  override var reason: String {
    "Original asset \(param) is stored in iCloud (Optimize iPhone Storage) and requires network access to download."
  }
}

internal final class PhotoPermissionDeniedException: Exception, @unchecked Sendable {
  override var code: String { "PHOTO_PERMISSION_DENIED" }
  override var reason: String {
    "Photo Library read permission is required to inspect and back up original photos."
  }
}

internal final class AssetNotFoundException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ASSET_NOT_FOUND" }
  override var reason: String {
    "Could not find Photo Library asset \(param)."
  }
}

internal final class MediaSyncOperationException: GenericException<(String, String)>, @unchecked Sendable {
  override var code: String { param.0 }
  override var reason: String { param.1 }
}

internal struct UploadChunkedOptions: Record {
  @Field var baseUrl: String = ""
  @Field var uploadId: String = ""
  @Field var fileUri: String = ""
  @Field var startOffset: Double = 0
  @Field var chunkSize: Double = 4_194_304
  @Field var csrfToken: String? = nil
  @Field var authToken: String? = nil
}

private final class ModuleEventRelay: @unchecked Sendable {
  private weak var module: MyDriveMediaSyncModule?

  init(_ module: MyDriveMediaSyncModule) {
    self.module = module
  }

  func send(_ name: String, _ body: [String: Any]) {
    module?.sendEvent(name, body)
  }
}

private final class ChunkTransferDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let onProgress: @Sendable (UInt64, UInt64) -> Void
  private var activeTaskId: Int?
  private var baseOffset: UInt64 = 0
  private var totalBytes: UInt64 = 0
  private var lastEmitTime: CFAbsoluteTime = 0
  private var receivedData = Data()
  private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?

  init(onProgress: @escaping @Sendable (UInt64, UInt64) -> Void) {
    self.onProgress = onProgress
  }

  func upload(
    session: URLSession,
    request: URLRequest,
    body: Data,
    baseOffset: UInt64,
    totalBytes: UInt64
  ) async throws -> (Data, HTTPURLResponse) {
    let task = session.uploadTask(with: request, from: body)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { cont in
        lock.lock()
        self.activeTaskId = task.taskIdentifier
        self.baseOffset = baseOffset
        self.totalBytes = totalBytes
        self.lastEmitTime = 0
        self.receivedData = Data()
        self.continuation = cont
        lock.unlock()
        task.resume()
      }
    } onCancel: {
      task.cancel()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    let callback: (@Sendable (UInt64, UInt64) -> Void)?
    let sent: UInt64
    let expected: UInt64

    lock.lock()
    if activeTaskId == task.taskIdentifier {
      let now = CFAbsoluteTimeGetCurrent()
      let isChunkDone = totalBytesExpectedToSend > 0 && totalBytesSent >= totalBytesExpectedToSend
      if isChunkDone || (now - lastEmitTime >= 0.1) {
        lastEmitTime = now
        let rawSent = baseOffset + UInt64(max(0, totalBytesSent))
        sent = min(totalBytes, rawSent)
        expected = totalBytes
        callback = onProgress
      } else {
        sent = 0
        expected = 0
        callback = nil
      }
    } else {
      sent = 0
      expected = 0
      callback = nil
    }
    lock.unlock()

    callback?(sent, expected)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    if activeTaskId == dataTask.taskIdentifier {
      receivedData.append(data)
    }
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    guard activeTaskId == task.taskIdentifier, let cont = continuation else {
      lock.unlock()
      return
    }
    let data = receivedData
    let response = task.response as? HTTPURLResponse
    activeTaskId = nil
    receivedData = Data()
    continuation = nil
    lock.unlock()

    if let error {
      cont.resume(throwing: error)
    } else if let response {
      cont.resume(returning: (data, response))
    } else {
      cont.resume(throwing: MediaSyncOperationException(("UPLOAD_FAILED", "No HTTP response returned for upload chunk.")))
    }
  }
}

private final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func testAndSet() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if value { return false }
    value = true
    return true
  }
}

private final class LockedBool: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func set(_ next: Bool) {
    lock.lock()
    defer { lock.unlock() }
    value = next
  }

  func get() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

private final class LockedProgressState: @unchecked Sendable {
  private let lock = NSLock()
  private var lastReported: Double = -1.0

  func shouldEmit(_ progress: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if progress >= 1.0 || progress <= 0.0 || (progress - lastReported) >= 0.05 {
      lastReported = progress
      return true
    }
    return false
  }
}

public final class MyDriveMediaSyncModule: Module {
  private let workQueue = DispatchQueue(
    label: "com.mydrive.ios.mediasync",
    qos: .userInitiated,
    attributes: .concurrent
  )

  public func definition() -> ModuleDefinition {
    Name("MyDriveMediaSync")

    Events("onICloudDownloadProgress", "onUploadProgress")

    AsyncFunction("inspectAssets") { (assetIds: [String], promise: Promise) in
      self.workQueue.async {
        guard Self.hasReadPermission() else {
          promise.reject(PhotoPermissionDeniedException())
          return
        }
        if assetIds.isEmpty {
          promise.resolve([])
          return
        }

        let normalizedIds = assetIds.map(Self.normalizeLocalIdentifier)
        let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: normalizedIds, options: nil)
        var byId: [String: PHAsset] = [:]
        fetchResult.enumerateObjects { asset, _, _ in
          byId[asset.localIdentifier] = asset
        }

        var results: [[String: Any?]] = []
        results.reserveCapacity(assetIds.count)
        for assetId in assetIds {
          guard let asset = byId[Self.normalizeLocalIdentifier(assetId)] else { continue }
          results.append(Self.buildAssetInspection(asset: asset, reportedId: assetId))
        }
        promise.resolve(results)
      }
    }

    AsyncFunction("prepareOriginalAsset") { (assetId: String, allowNetwork: Bool, promise: Promise) in
      let relay = ModuleEventRelay(self)
      self.workQueue.async {
        guard Self.hasReadPermission() else {
          promise.reject(PhotoPermissionDeniedException())
          return
        }

        let normalizedId = Self.normalizeLocalIdentifier(assetId)
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [normalizedId], options: nil)
        guard let asset = fetched.firstObject else {
          promise.reject(AssetNotFoundException(assetId))
          return
        }

        guard let resource = Self.selectOriginalResource(for: asset) else {
          promise.reject(
            MediaSyncOperationException(("ASSET_NO_RESOURCE", "No exportable PhotoKit resource found for \(assetId)."))
          )
          return
        }

        let inICloud = Self.checkIsAssetInICloud(asset: asset)
        if inICloud && !allowNetwork {
          promise.reject(ICloudNetworkRequiredException(assetId))
          return
        }

        let filename = Self.resolvedOriginalFilename(resource: resource, asset: asset)
        let mimeType = Self.resolvedMimeType(resource: resource, filename: filename)
        let stagingDir: URL
        do {
          stagingDir = try Self.ensureStagingDirectory()
        } catch {
          promise.reject(
            MediaSyncOperationException(("STAGING_DIR_ERROR", "Unable to prepare staging directory: \(error.localizedDescription)"))
          )
          return
        }

        let destUrl = stagingDir.appendingPathComponent("\(UUID().uuidString)_\(filename)")
        try? FileManager.default.removeItem(at: destUrl)

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = allowNetwork
        let progressGate = LockedProgressState()
        options.progressHandler = { progress in
          if progressGate.shouldEmit(progress) {
            relay.send(
              "onICloudDownloadProgress",
              [
                "assetId": assetId,
                "progress": min(1.0, max(0.0, progress)),
                "phase": "downloading_icloud",
              ]
            )
          }
        }

        let workQueue = self.workQueue
        PHAssetResourceManager.default().writeData(
          for: resource,
          toFile: destUrl,
          options: options
        ) { error in
          if let error = error {
            try? FileManager.default.removeItem(at: destUrl)
            let nsError = error as NSError
            if nsError.domain == PHPhotosError.errorDomain,
               nsError.code == PHPhotosError.networkAccessRequired.rawValue
            {
              promise.reject(ICloudNetworkRequiredException(assetId))
            } else {
              promise.reject(
                MediaSyncOperationException((
                  "ASSET_EXPORT_FAILED",
                  "Failed to read original asset \(filename) from Photo Library/iCloud: \(error.localizedDescription)"
                ))
              )
            }
            return
          }

          workQueue.async {
            do {
              relay.send(
                "onICloudDownloadProgress",
                [
                  "assetId": assetId,
                  "progress": 1.0,
                  "phase": "hashing",
                ]
              )
              let (sha256Hex, sizeBytes) = try Self.streamSha256(fileURL: destUrl)
              let result: [String: Any?] = [
                "assetId": assetId,
                "tempFilePath": destUrl.path,
                "tempFileUri": destUrl.absoluteString,
                "filename": filename,
                "mimeType": mimeType,
                "sizeBytes": Int64(sizeBytes),
                "sha256": sha256Hex,
                "downloadedFromICloud": inICloud,
                "width": asset.pixelWidth,
                "height": asset.pixelHeight,
                "creationDateIso": Self.isoString(asset.creationDate),
                "modificationDateIso": Self.isoString(asset.modificationDate),
              ]
              promise.resolve(result)
            } catch {
              try? FileManager.default.removeItem(at: destUrl)
              promise.reject(
                MediaSyncOperationException((
                  "HASH_FAILED",
                  "Unable to compute SHA-256 for \(filename): \(error.localizedDescription)"
                ))
              )
            }
          }
        }
      }
    }

    AsyncFunction("cleanupPreparedFile") { (tempFilePath: String) in
      guard !tempFilePath.isEmpty else { return }
      let stagingRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("mydrive-sync-staging", isDirectory: true)
        .standardizedFileURL
        .path
      let target = URL(fileURLWithPath: tempFilePath).standardizedFileURL
      guard target.path.hasPrefix(stagingRoot) else { return }
      try? FileManager.default.removeItem(at: target)
    }

    AsyncFunction("hashFileSha256") { (fileUri: String, promise: Promise) in
      self.workQueue.async {
        do {
          let fileURL = Self.resolveLocalFileURL(fileUri)
          let (sha256Hex, sizeBytes) = try Self.streamSha256(fileURL: fileURL)
          promise.resolve([
            "sha256": sha256Hex,
            "sizeBytes": Int64(sizeBytes),
          ])
        } catch {
          promise.reject(
            MediaSyncOperationException((
              "HASH_FAILED",
              "Could not hash file \(fileUri): \(error.localizedDescription)"
            ))
          )
        }
      }
    }

    AsyncFunction("uploadFileChunked") { (options: UploadChunkedOptions, promise: Promise) in
      let relay = ModuleEventRelay(self)
      let baseUrl = options.baseUrl
      let uploadId = options.uploadId
      let fileUri = options.fileUri
      let startOffset = options.startOffset
      let chunkSize = options.chunkSize
      let csrfToken = options.csrfToken
      let authToken = options.authToken

      Task.detached(priority: .userInitiated) {
        do {
          let finalOffset = try await Self.performChunkedUpload(
            baseUrl: baseUrl,
            uploadId: uploadId,
            fileUri: fileUri,
            startOffset: startOffset,
            chunkSize: chunkSize,
            csrfToken: csrfToken,
            authToken: authToken
          ) { uploaded, total in
            relay.send(
              "onUploadProgress",
              [
                "uploadId": uploadId,
                "uploadedBytes": Int64(uploaded),
                "totalBytes": Int64(total),
              ]
            )
          }
          promise.resolve(Int64(finalOffset))
        } catch let error as MediaSyncOperationException {
          promise.reject(error)
        } catch {
          promise.reject(
            MediaSyncOperationException(("UPLOAD_FAILED", "Upload failed: \(error.localizedDescription)"))
          )
        }
      }
    }

    AsyncFunction("downloadToLocalFile") { (urlString: String, filename: String, authToken: String?, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        guard let url = URL(string: urlString) else {
          promise.reject(MediaSyncOperationException(("INVALID_URL", "Invalid download URL.")))
          return
        }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = true
        request.timeoutInterval = 300
        if let token = authToken?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
          request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
          let (tempURL, response) = try await URLSession.shared.download(for: request)
          guard let httpResponse = response as? HTTPURLResponse else {
            try? FileManager.default.removeItem(at: tempURL)
            promise.reject(MediaSyncOperationException(("DOWNLOAD_FAILED", "Invalid HTTP response.")))
            return
          }
          guard (200...299).contains(httpResponse.statusCode) else {
            try? FileManager.default.removeItem(at: tempURL)
            promise.reject(
              MediaSyncOperationException((
                "DOWNLOAD_HTTP_\(httpResponse.statusCode)",
                "Download failed with HTTP \(httpResponse.statusCode)."
              ))
            )
            return
          }

          let downloadsRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("mydrive-downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
          try FileManager.default.createDirectory(at: downloadsRoot, withIntermediateDirectories: true)

          let cleanName = Self.sanitizeFilename(filename.isEmpty ? (httpResponse.suggestedFilename ?? "file") : filename)
          let finalURL = downloadsRoot.appendingPathComponent(cleanName)
          try? FileManager.default.removeItem(at: finalURL)
          try FileManager.default.moveItem(at: tempURL, to: finalURL)

          let attrs = try FileManager.default.attributesOfItem(atPath: finalURL.path)
          let sizeBytes = (attrs[.size] as? NSNumber)?.int64Value ?? 0
          let mimeType = httpResponse.value(forHTTPHeaderField: "Content-Type")
            ?? UTType(filenameExtension: finalURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"

          promise.resolve([
            "localUri": finalURL.absoluteString,
            "path": finalURL.path,
            "mimeType": mimeType,
            "sizeBytes": sizeBytes,
          ])
        } catch {
          promise.reject(
            MediaSyncOperationException(("DOWNLOAD_FAILED", "Download failed: \(error.localizedDescription)"))
          )
        }
      }
    }

    AsyncFunction("clearSessionCookies") { (baseUrlString: String) in
      guard let url = URL(string: baseUrlString),
            let host = url.host?.lowercased(),
            let cookies = HTTPCookieStorage.shared.cookies
      else { return }
      for cookie in cookies where cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == host {
        HTTPCookieStorage.shared.deleteCookie(cookie)
      }
    }

    AsyncFunction("getWifiSubnetInfo") { () -> [String: Any]? in
      guard let iface = Self.detectLanInterface() else {
        return nil
      }
      return [
        "interfaceName": iface.name,
        "localIp": iface.ip,
        "netmask": iface.netmask,
        "subnetPrefix": iface.subnetPrefix,
      ]
    }

    AsyncFunction("discoverLanServers") { (ports: [Int]?, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        let candidatePorts = (ports?.isEmpty == false ? ports! : [3000, 80, 8080, 443, 8443])
          .filter { $0 > 0 && $0 <= 65535 }
        let results = await Self.scanLanForServers(ports: candidatePorts)
        promise.resolve(results)
      }
    }

    AsyncFunction("inspectLocalCaches") { (promise: Promise) in
      Task.detached(priority: .utility) {
        let stats = Self.collectLocalCacheStats()
        promise.resolve(stats)
      }
    }

    AsyncFunction("clearLocalCacheCategory") { (category: String, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        let result = await Self.clearNativeCacheCategory(category)
        promise.resolve(result)
      }
    }

    AsyncFunction("deleteCachedFile") { (filePath: String, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        let result = Self.removeSingleSafeCachedFile(filePath: filePath)
        promise.resolve(result)
      }
    }

    AsyncFunction("pruneExpiredTempCache") { (maxAgeSeconds: Double, includeSyncStaging: Bool, promise: Promise) in
      Task.detached(priority: .utility) {
        let result = Self.pruneExpiredTempFiles(
          maxAgeSeconds: maxAgeSeconds,
          includeSyncStaging: includeSyncStaging
        )
        promise.resolve(result)
      }
    }
  }

  private static func normalizeLocalIdentifier(_ assetId: String) -> String {
    if assetId.hasPrefix("ph://") {
      return String(assetId.dropFirst("ph://".count))
    }
    return assetId
  }

  private static func hasReadPermission() -> Bool {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return status == .authorized || status == .limited
  }

  private static func buildAssetInspection(asset: PHAsset, reportedId: String? = nil) -> [String: Any?] {
    let resources = PHAssetResource.assetResources(for: asset)
    let primary = selectOriginalResource(for: asset, resources: resources)
    let filename = primary.map { resolvedOriginalFilename(resource: $0, asset: asset) }
      ?? ((asset.value(forKey: "filename") as? String) ?? "asset_\(asset.localIdentifier.prefix(8))")
    let uti = primary?.uniformTypeIdentifier ?? ""
    let mimeType = primary.map { resolvedMimeType(resource: $0, filename: filename) } ?? "application/octet-stream"
    let inICloud = checkIsAssetInICloud(asset: asset)
    let hasLivePhotoVideo = resources.contains(where: { $0.type == .pairedVideo || $0.type == .fullSizePairedVideo })

    return [
      "assetId": reportedId ?? asset.localIdentifier,
      "mediaType": asset.mediaType == .video ? "video" : "image",
      "originalFilename": filename,
      "uniformTypeIdentifier": uti,
      "mimeType": mimeType,
      "inICloud": inICloud,
      "originalLocallyAvailable": !inICloud,
      "pixelWidth": asset.pixelWidth,
      "pixelHeight": asset.pixelHeight,
      "durationSeconds": asset.duration,
      "creationTimestampMs": asset.creationDate.map { $0.timeIntervalSince1970 * 1000.0 },
      "modificationTimestampMs": asset.modificationDate.map { $0.timeIntervalSince1970 * 1000.0 },
      "hasLivePhotoVideo": hasLivePhotoVideo,
    ]
  }

  private static func selectOriginalResource(
    for asset: PHAsset,
    resources: [PHAssetResource]? = nil
  ) -> PHAssetResource? {
    let all = resources ?? PHAssetResource.assetResources(for: asset)
    let preferredTypes: [PHAssetResourceType] = asset.mediaType == .video
      ? [.video, .fullSizeVideo]
      : [.photo, .alternatePhoto, .fullSizePhoto]

    for targetType in preferredTypes {
      if let found = all.first(where: { $0.type == targetType }) {
        return found
      }
    }
    return all.first
  }

  private static func checkIsAssetInICloud(asset: PHAsset) -> Bool {
    let group = DispatchGroup()
    let once = LockedFlag()
    let cloudState = LockedBool()

    group.enter()
    if asset.mediaType == .video {
      let options = PHVideoRequestOptions()
      options.version = .original
      options.deliveryMode = .highQualityFormat
      options.isNetworkAccessAllowed = false
      PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
        let cloudFlag = (info?[PHImageResultIsInCloudKey] as? Bool) ?? false
        let missingLocal = (avAsset == nil)
        cloudState.set(cloudFlag || missingLocal)
        if once.testAndSet() {
          group.leave()
        }
      }
    } else {
      let options = PHImageRequestOptions()
      options.version = .original
      options.deliveryMode = .highQualityFormat
      options.isNetworkAccessAllowed = false
      options.isSynchronous = false
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, info in
        let cloudFlag = (info?[PHImageResultIsInCloudKey] as? Bool) ?? false
        let missingLocal = (data == nil)
        cloudState.set(cloudFlag || missingLocal)
        if once.testAndSet() {
          group.leave()
        }
      }
    }

    _ = group.wait(timeout: .now() + 8)
    return cloudState.get()
  }

  private static func resolvedOriginalFilename(resource: PHAssetResource, asset: PHAsset) -> String {
    var raw = sanitizeFilename(resource.originalFilename)
    if raw.isEmpty {
      raw = asset.mediaType == .video ? "video.mov" : "photo.heic"
    }
    if (raw as NSString).pathExtension.isEmpty,
       let ext = UTType(resource.uniformTypeIdentifier)?.preferredFilenameExtension
    {
      raw += ".\(ext)"
    }
    return raw
  }

  private static func resolvedMimeType(resource: PHAssetResource, filename: String) -> String {
    if let mime = UTType(resource.uniformTypeIdentifier)?.preferredMIMEType {
      return mime
    }
    let ext = (filename as NSString).pathExtension
    if !ext.isEmpty, let mime = UTType(filenameExtension: ext)?.preferredMIMEType {
      return mime
    }
    return "application/octet-stream"
  }

  private static func ensureStagingDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("mydrive-sync-staging", isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return dir
  }

  private static func resolveLocalFileURL(_ uriOrPath: String) -> URL {
    if uriOrPath.hasPrefix("file://"), let url = URL(string: uriOrPath) {
      return url
    }
    return URL(fileURLWithPath: uriOrPath)
  }

  private static func streamSha256(fileURL: URL) throws -> (String, UInt64) {
    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }

    var hasher = SHA256()
    var totalBytes: UInt64 = 0
    let bufferSize = 1_048_576
    while true {
      let chunk = try handle.read(upToCount: bufferSize) ?? Data()
      if chunk.isEmpty { break }
      hasher.update(data: chunk)
      totalBytes += UInt64(chunk.count)
    }
    let digest = hasher.finalize()
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return (hex, totalBytes)
  }

  private static func parseUploadOffset(_ response: HTTPURLResponse) -> UInt64? {
    for (key, value) in response.allHeaderFields {
      if String(describing: key).lowercased() == "upload-offset",
         let parsed = UInt64(String(describing: value).trimmingCharacters(in: .whitespaces))
      {
        return parsed
      }
    }
    return nil
  }

  private static func isRetryableTransportError(_ error: Error) -> Bool {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
      switch nsError.code {
      case NSURLErrorTimedOut,
           NSURLErrorCannotFindHost,
           NSURLErrorCannotConnectToHost,
           NSURLErrorNetworkConnectionLost,
           NSURLErrorDNSLookupFailed,
           NSURLErrorNotConnectedToInternet,
           NSURLErrorResourceUnavailable,
           NSURLErrorInternationalRoamingOff,
           NSURLErrorDataNotAllowed:
        return true
      default:
        return false
      }
    }
    return false
  }

  private static func isRetryableStatus(_ statusCode: Int) -> Bool {
    return statusCode == 408 || statusCode == 429 || (500...599).contains(statusCode)
  }

  private static func fetchRemoteUploadOffset(
    session: URLSession,
    patchURL: URL,
    csrfToken: String?,
    authToken: String?
  ) async -> UInt64? {
    var headRequest = URLRequest(url: patchURL)
    headRequest.httpMethod = "HEAD"
    headRequest.httpShouldHandleCookies = true
    headRequest.timeoutInterval = 20
    headRequest.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
    if let csrf = csrfToken, !csrf.isEmpty {
      headRequest.setValue(csrf, forHTTPHeaderField: "X-Csrf-Token")
    }
    if let authToken = authToken?.trimmingCharacters(in: .whitespacesAndNewlines), !authToken.isEmpty {
      headRequest.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    }
    do {
      let (_, response) = try await session.data(for: headRequest)
      if let httpResponse = response as? HTTPURLResponse,
         (200...299).contains(httpResponse.statusCode)
      {
        return parseUploadOffset(httpResponse)
      }
    } catch {
      // Caller falls back to existing offset or next retry.
    }
    return nil
  }

  private static func performChunkedUpload(
    baseUrl: String,
    uploadId: String,
    fileUri: String,
    startOffset: Double,
    chunkSize: Double,
    csrfToken: String?,
    authToken: String?,
    onProgress: @Sendable @escaping (UInt64, UInt64) -> Void
  ) async throws -> UInt64 {
    let trimmedBase = baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let patchURL = URL(string: "\(trimmedBase)/api/uploads/\(uploadId)") else {
      throw MediaSyncOperationException(("INVALID_URL", "Invalid upload endpoint URL."))
    }

    let fileURL = resolveLocalFileURL(fileUri)
    let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
    let totalBytes = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }

    var offset = UInt64(max(0, Int64(startOffset)))
    if totalBytes == 0 {
      onProgress(0, 0)
      return 0
    }

    let minChunk: UInt64 = 512 * 1024
    let requestedChunk = UInt64(max(0, Int64(chunkSize)))
    let maxChunk: UInt64 = min(32 * 1024 * 1024, max(8 * 1024 * 1024, requestedChunk))
    var adaptiveChunk = min(maxChunk, max(minChunk, requestedChunk))
    let resolvedCsrf = resolveCsrfToken(explicit: csrfToken, for: patchURL)
    let resolvedAuth = authToken?.trimmingCharacters(in: .whitespacesAndNewlines)

    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 45
    config.timeoutIntervalForResource = 300
    config.httpCookieStorage = HTTPCookieStorage.shared
    config.httpShouldSetCookies = true
    config.requestCachePolicy = .reloadIgnoringLocalCacheData

    let delegate = ChunkTransferDelegate(onProgress: onProgress)
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }

    var conflictRetries = 0
    var transientFailures = 0
    let maxTransientFailures = 4

    while offset < totalBytes {
      try handle.seek(toOffset: offset)
      let remaining = totalBytes - offset
      let toRead = Int(min(adaptiveChunk, remaining))
      let chunk = try handle.read(upToCount: toRead) ?? Data()
      if chunk.isEmpty {
        throw MediaSyncOperationException(("UPLOAD_EOF", "Unexpected EOF while reading upload chunk."))
      }

      var request = URLRequest(url: patchURL)
      request.httpMethod = "PATCH"
      request.httpShouldHandleCookies = true
      request.timeoutInterval = 120
      request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
      request.setValue("\(offset)", forHTTPHeaderField: "Upload-Offset")
      request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
      if let csrf = resolvedCsrf, !csrf.isEmpty {
        request.setValue(csrf, forHTTPHeaderField: "X-Csrf-Token")
      }
      if let resolvedAuth, !resolvedAuth.isEmpty {
        request.setValue("Bearer \(resolvedAuth)", forHTTPHeaderField: "Authorization")
      }

      let chunkStart = CFAbsoluteTimeGetCurrent()
      do {
        let (data, httpResponse) = try await delegate.upload(
          session: session,
          request: request,
          body: chunk,
          baseOffset: offset,
          totalBytes: totalBytes
        )

        if httpResponse.statusCode == 409 && conflictRetries < 3 {
          conflictRetries += 1
          adaptiveChunk = max(minChunk, adaptiveChunk / 2)
          if let headerOffset = parseUploadOffset(httpResponse) {
            offset = min(totalBytes, headerOffset)
            onProgress(offset, totalBytes)
            continue
          }
          if let headOffset = await fetchRemoteUploadOffset(
            session: session,
            patchURL: patchURL,
            csrfToken: resolvedCsrf,
            authToken: resolvedAuth
          ) {
            offset = min(totalBytes, headOffset)
            onProgress(offset, totalBytes)
            continue
          }
        }

        if isRetryableStatus(httpResponse.statusCode) && transientFailures < maxTransientFailures {
          transientFailures += 1
          adaptiveChunk = max(minChunk, adaptiveChunk / 2)
          if let headOffset = await fetchRemoteUploadOffset(
            session: session,
            patchURL: patchURL,
            csrfToken: resolvedCsrf,
            authToken: resolvedAuth
          ) {
            offset = min(totalBytes, headOffset)
            onProgress(offset, totalBytes)
          }
          let backoffNs = UInt64(min(10.0, 0.7 * pow(2.0, Double(transientFailures - 1))) * 1_000_000_000)
          try await Task.sleep(nanoseconds: backoffNs)
          continue
        }

        guard (200...299).contains(httpResponse.statusCode) else {
          let detail = String(data: data, encoding: .utf8) ?? ""
          throw MediaSyncOperationException((
            "UPLOAD_HTTP_\(httpResponse.statusCode)",
            "Upload chunk rejected (HTTP \(httpResponse.statusCode)): \(detail)"
          ))
        }

        conflictRetries = 0
        transientFailures = 0

        let elapsed = max(0.05, CFAbsoluteTimeGetCurrent() - chunkStart)
        let throughput = Double(chunk.count) / elapsed
        if elapsed <= 1.8 && throughput >= 8 * 1024 * 1024 {
          adaptiveChunk = min(maxChunk, adaptiveChunk * 2)
        } else if elapsed >= 10.0 || throughput < 1.5 * 1024 * 1024 {
          adaptiveChunk = max(minChunk, adaptiveChunk / 2)
        }

        if let nextOffset = parseUploadOffset(httpResponse) {
          offset = min(totalBytes, max(offset + UInt64(chunk.count), nextOffset))
        } else {
          offset = min(totalBytes, offset + UInt64(chunk.count))
        }
        onProgress(offset, totalBytes)
      } catch let opError as MediaSyncOperationException {
        throw opError
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        if isRetryableTransportError(error) && transientFailures < maxTransientFailures {
          transientFailures += 1
          adaptiveChunk = max(minChunk, adaptiveChunk / 2)
          if let headOffset = await fetchRemoteUploadOffset(
            session: session,
            patchURL: patchURL,
            csrfToken: resolvedCsrf,
            authToken: resolvedAuth
          ) {
            offset = min(totalBytes, headOffset)
            onProgress(offset, totalBytes)
          }
          let backoffNs = UInt64(min(10.0, 0.7 * pow(2.0, Double(transientFailures - 1))) * 1_000_000_000)
          try await Task.sleep(nanoseconds: backoffNs)
          continue
        }
        throw error
      }
    }

    return offset
  }

  private static func resolveCsrfToken(explicit: String?, for url: URL) -> String? {
    if let explicit, !explicit.isEmpty {
      return explicit
    }
    let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
    for cookie in cookies {
      if cookie.name == "__Host-my_drive_csrf" || cookie.name == "my_drive_csrf" {
        return cookie.value
      }
    }
    return nil
  }

  private static func sanitizeFilename(_ name: String) -> String {
    let invalid = CharacterSet(charactersIn: "/\\:*?\"<>|\0")
    let cleaned = name.components(separatedBy: invalid).joined(separator: "_")
    let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "file" : trimmed
  }

  private static func isoString(_ date: Date?) -> String? {
    guard let date else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private struct LanInterfaceInfo {
    let name: String
    let ip: String
    let netmask: String
    let hostInt: UInt32
    let subnetPrefix: String
  }

  private final class ProbeResumeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) {
      self.continuation = continuation
    }

    func finish(_ value: Bool) {
      lock.lock()
      let cont = continuation
      continuation = nil
      lock.unlock()
      cont?.resume(returning: value)
    }
  }

  private static func isPrivateLanIpv4(_ host: UInt32) -> Bool {
    let octets = (
      (host >> 24) & 0xFF,
      (host >> 16) & 0xFF,
      (host >> 8) & 0xFF,
      host & 0xFF
    )
    if octets.0 == 10 { return true }
    if octets.0 == 172 && (16...31).contains(octets.1) { return true }
    if octets.0 == 192 && octets.1 == 168 { return true }
    return false
  }

  private static func ipv4String(_ host: UInt32) -> String {
    "\((host >> 24) & 0xFF).\((host >> 16) & 0xFF).\((host >> 8) & 0xFF).\(host & 0xFF)"
  }

  private static func detectLanInterface() -> LanInterfaceInfo? {
    var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddrPtr) == 0, let firstAddr = ifaddrPtr else {
      return nil
    }
    defer { freeifaddrs(ifaddrPtr) }

    var candidates: [LanInterfaceInfo] = []
    var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
    while let ifa = ptr?.pointee {
      defer { ptr = ifa.ifa_next }
      guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else {
        continue
      }
      let flags = Int32(ifa.ifa_flags)
      guard (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
            (flags & IFF_LOOPBACK) == 0
      else {
        continue
      }
      let name = String(cString: ifa.ifa_name)
      if name.hasPrefix("pdp_ip") || name.hasPrefix("utun") || name.hasPrefix("ipsec") || name.hasPrefix("awdl") {
        continue
      }
      let sin = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
      let hostInt = UInt32(bigEndian: sin.sin_addr.s_addr)
      guard isPrivateLanIpv4(hostInt) else {
        continue
      }
      var netmaskStr = "255.255.255.0"
      if let netmaskAddr = ifa.ifa_netmask {
        let maskSin = netmaskAddr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
        netmaskStr = ipv4String(UInt32(bigEndian: maskSin.sin_addr.s_addr))
      }
      let ip = ipv4String(hostInt)
      let subnetPrefix = "\((hostInt >> 24) & 0xFF).\((hostInt >> 16) & 0xFF).\((hostInt >> 8) & 0xFF)"
      candidates.append(
        LanInterfaceInfo(
          name: name,
          ip: ip,
          netmask: netmaskStr,
          hostInt: hostInt,
          subnetPrefix: subnetPrefix
        )
      )
    }

    if let wifi = candidates.first(where: { $0.name == "en0" }) {
      return wifi
    }
    if let wired = candidates.first(where: { $0.name.hasPrefix("en") }) {
      return wired
    }
    return candidates.first
  }

  private static func probeTcpPort(ip: String, port: UInt16, timeoutSeconds: Double = 0.45) async -> Bool {
    guard let nwPort = NWEndpoint.Port(rawValue: port) else {
      return false
    }
    return await withCheckedContinuation { continuation in
      let box = ProbeResumeBox(continuation)
      let connection = NWConnection(host: NWEndpoint.Host(ip), port: nwPort, using: .tcp)
      let queue = DispatchQueue(label: "mydrive.lan.probe.\(ip).\(port)")

      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          box.finish(true)
          connection.cancel()
        case .failed, .cancelled:
          box.finish(false)
          connection.cancel()
        default:
          break
        }
      }

      connection.start(queue: queue)
      queue.asyncAfter(deadline: .now() + timeoutSeconds) {
        box.finish(false)
        connection.cancel()
      }
    }
  }

  private static func fetchWellKnownCloudClient(
    ip: String,
    port: Int,
    scheme: String
  ) async -> [String: Any]? {
    let defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
    let origin = defaultPort ? "\(scheme)://\(ip)" : "\(scheme)://\(ip):\(port)"
    guard let url = URL(string: "\(origin)/.well-known/cloud-client") else {
      return nil
    }

    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 1.6
    config.timeoutIntervalForResource = 2.0
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: config)
    defer { session.finishTasksAndInvalidate() }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let started = CFAbsoluteTimeGetCurrent()

    do {
      let (data, response) = try await session.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse,
            httpResponse.statusCode == 200,
            let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            (payload["product"] as? String) == "my-drive"
      else {
        return nil
      }
      let latencyMs = max(1, Int(((CFAbsoluteTimeGetCurrent() - started) * 1000.0).rounded()))
      var result: [String: Any] = [
        "url": origin,
        "ip": ip,
        "port": port,
        "scheme": scheme,
        "product": "my-drive",
        "latencyMs": latencyMs,
      ]
      if let serverId = payload["serverId"] as? String {
        result["serverId"] = serverId
      }
      if let serverVersion = payload["serverVersion"] as? String {
        result["serverVersion"] = serverVersion
      }
      if let apiVersion = payload["apiVersion"] as? String {
        result["apiVersion"] = apiVersion
      }
      return result
    } catch {
      return nil
    }
  }

  private static func scanLanForServers(ports: [Int]) async -> [[String: Any]] {
    guard let iface = detectLanInterface() else {
      return []
    }
    let prefixBase = iface.hostInt & 0xFFFF_FF00
    let selfHost = iface.hostInt & 0x0000_00FF
    let targetIps: [String] = (1...254)
      .filter { UInt32($0) != selfHost }
      .map { ipv4String(prefixBase | UInt32($0)) }

    let targets: [(ip: String, port: Int)] = targetIps.flatMap { ip in
      ports.map { (ip: ip, port: $0) }
    }

    var openEndpoints: [(ip: String, port: Int)] = []
    let maxConcurrency = 48
    var index = 0

    await withTaskGroup(of: (String, Int)?.self) { group in
      while index < min(maxConcurrency, targets.count) {
        let target = targets[index]
        index += 1
        group.addTask {
          guard target.port > 0, target.port <= 65535 else { return nil }
          let reachable = await probeTcpPort(ip: target.ip, port: UInt16(target.port))
          return reachable ? (target.ip, target.port) : nil
        }
      }

      while let result = await group.next() {
        if let found = result {
          openEndpoints.append(found)
        }
        if index < targets.count {
          let target = targets[index]
          index += 1
          group.addTask {
            guard target.port > 0, target.port <= 65535 else { return nil }
            let reachable = await probeTcpPort(ip: target.ip, port: UInt16(target.port))
            return reachable ? (target.ip, target.port) : nil
          }
        }
      }
    }

    if openEndpoints.isEmpty {
      return []
    }

    var servers: [[String: Any]] = []
    var seenUrls = Set<String>()
    await withTaskGroup(of: [String: Any]?.self) { group in
      for endpoint in openEndpoints {
        let schemes = (endpoint.port == 443 || endpoint.port == 8443) ? ["https", "http"] : ["http", "https"]
        group.addTask {
          for scheme in schemes {
            if let verified = await fetchWellKnownCloudClient(ip: endpoint.ip, port: endpoint.port, scheme: scheme) {
              return verified
            }
          }
          return nil
        }
      }
      for await hit in group {
        if let verified = hit, let url = verified["url"] as? String, !seenUrls.contains(url) {
          seenUrls.insert(url)
          servers.append(verified)
        }
      }
    }

    return servers.sorted {
      ($0["latencyMs"] as? Int ?? Int.max) < ($1["latencyMs"] as? Int ?? Int.max)
    }
  }

  // MARK: - Local Cache Inspection & Cleanup

  private struct ScannedFileItem {
    let path: String
    let name: String
    let sizeBytes: Int64
    let modifiedAtMs: Double
  }

  private struct DirectoryScanStats {
    var sizeBytes: Int64 = 0
    var fileCount: Int = 0
    var items: [ScannedFileItem] = []
  }

  private static let imageCacheDirName = "com.hackemist.SDImageCache"
  private static let videoCacheDirName = "expo-video-cache"
  private static let documentPickerDirName = "DocumentPicker"
  private static let downloadsDirName = "mydrive-downloads"
  private static let syncStagingDirName = "mydrive-sync-staging"
  private static let webKitDirName = "WebKit"

  private static func cachesRootDirectory(fm: FileManager = FileManager()) -> URL? {
    fm.urls(for: .cachesDirectory, in: .userDomainMask).first
  }

  private static func documentsRootDirectory(fm: FileManager = FileManager()) -> URL? {
    fm.urls(for: .documentDirectory, in: .userDomainMask).first
  }

  private static func temporaryRootDirectory(fm: FileManager = FileManager()) -> URL {
    fm.temporaryDirectory
  }

  private static func isSystemManagedCacheEntry(_ name: String) -> Bool {
    if name == "Snapshots" { return true }
    if name.hasPrefix("com.apple.") { return true }
    return false
  }

  private static func isKnownDedicatedCacheEntry(_ name: String, bundleId: String?) -> Bool {
    if name == imageCacheDirName
      || name == videoCacheDirName
      || name == documentPickerDirName
      || name == webKitDirName
    {
      return true
    }
    if let bundleId, !bundleId.isEmpty, name == bundleId {
      return true
    }
    return false
  }

  private static func scanItemStats(
    at url: URL,
    collectFiles: Bool = false,
    fm: FileManager = FileManager()
  ) -> DirectoryScanStats {
    var stats = DirectoryScanStats()
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else {
      return stats
    }

    let keys: Set<URLResourceKey> = [
      .isRegularFileKey,
      .fileSizeKey,
      .contentModificationDateKey,
    ]

    if !isDir.boolValue {
      if let values = try? url.resourceValues(forKeys: keys),
         values.isRegularFile == true
      {
        let size = Int64(values.fileSize ?? 0)
        stats.sizeBytes = size
        stats.fileCount = 1
        if collectFiles {
          let modMs = (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000.0
          stats.items.append(
            ScannedFileItem(
              path: url.path,
              name: url.lastPathComponent,
              sizeBytes: size,
              modifiedAtMs: modMs
            )
          )
        }
      }
      return stats
    }

    guard let enumerator = fm.enumerator(
      at: url,
      includingPropertiesForKeys: Array(keys),
      options: []
    ) else {
      return stats
    }

    while let entry = enumerator.nextObject() as? URL {
      guard let values = try? entry.resourceValues(forKeys: keys),
            values.isRegularFile == true
      else {
        continue
      }
      let size = Int64(values.fileSize ?? 0)
      stats.sizeBytes += size
      stats.fileCount += 1
      if collectFiles {
        let modMs = (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000.0
        stats.items.append(
          ScannedFileItem(
            path: entry.path,
            name: entry.lastPathComponent,
            sizeBytes: size,
            modifiedAtMs: modMs
          )
        )
      }
    }

    return stats
  }

  private static func deviceStorageCapacity(fm: FileManager = FileManager()) -> (total: Int64, free: Int64) {
    let probeUrl = documentsRootDirectory(fm: fm) ?? URL(fileURLWithPath: NSHomeDirectory())
    let resourceValues = try? probeUrl.resourceValues(forKeys: [
      .volumeTotalCapacityKey,
      .volumeAvailableCapacityForImportantUsageKey,
    ])
    var total = Int64(resourceValues?.volumeTotalCapacity ?? 0)
    var free = resourceValues?.volumeAvailableCapacityForImportantUsage ?? 0

    if total <= 0 || free <= 0,
       let attrs = try? fm.attributesOfFileSystem(forPath: probeUrl.path)
    {
      if total <= 0 {
        total = (attrs[.systemSize] as? NSNumber)?.int64Value ?? 0
      }
      if free <= 0 {
        free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
      }
    }

    return (max(0, total), max(0, free))
  }

  private static func collectLocalCacheStats() -> [String: Any] {
    let fm = FileManager()
    let cachesRoot = cachesRootDirectory(fm: fm)
    let tempRoot = temporaryRootDirectory(fm: fm)
    let docsRoot = documentsRootDirectory(fm: fm)
    let bundleId = Bundle.main.bundleIdentifier

    let imageScan = cachesRoot
      .map { scanItemStats(at: $0.appendingPathComponent(imageCacheDirName, isDirectory: true), fm: fm) }
      ?? DirectoryScanStats()

    let videoScan = cachesRoot
      .map { scanItemStats(at: $0.appendingPathComponent(videoCacheDirName, isDirectory: true), fm: fm) }
      ?? DirectoryScanStats()

    let downloadsDir = tempRoot.appendingPathComponent(downloadsDirName, isDirectory: true)
    let downloadsScan = scanItemStats(at: downloadsDir, collectFiles: true, fm: fm)
    let topDownloads: [[String: Any]] = downloadsScan.items
      .sorted { $0.modifiedAtMs > $1.modifiedAtMs }
      .prefix(60)
      .map { item in
        [
          "id": item.path,
          "path": item.path,
          "name": item.name,
          "sizeBytes": item.sizeBytes,
          "modifiedAtMs": item.modifiedAtMs,
        ]
      }

    var stagingBytes: Int64 = 0
    var stagingFiles = 0
    let syncStagingScan = scanItemStats(
      at: tempRoot.appendingPathComponent(syncStagingDirName, isDirectory: true),
      fm: fm
    )
    stagingBytes += syncStagingScan.sizeBytes
    stagingFiles += syncStagingScan.fileCount

    if let pickerDir = cachesRoot?.appendingPathComponent(documentPickerDirName, isDirectory: true) {
      let pickerScan = scanItemStats(at: pickerDir, fm: fm)
      stagingBytes += pickerScan.sizeBytes
      stagingFiles += pickerScan.fileCount
    }

    if let tempEntries = try? fm.contentsOfDirectory(
      at: tempRoot,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ) {
      for entry in tempEntries {
        let name = entry.lastPathComponent
        if name == downloadsDirName || name == syncStagingDirName {
          continue
        }
        let scan = scanItemStats(at: entry, fm: fm)
        stagingBytes += scan.sizeBytes
        stagingFiles += scan.fileCount
      }
    }

    var networkBytes: Int64 = 0
    var networkFiles = 0
    if let cachesRoot {
      if let bundleId, !bundleId.isEmpty {
        let bundleCache = scanItemStats(
          at: cachesRoot.appendingPathComponent(bundleId, isDirectory: true),
          fm: fm
        )
        networkBytes += bundleCache.sizeBytes
        networkFiles += bundleCache.fileCount
      }
      let webKitScan = scanItemStats(
        at: cachesRoot.appendingPathComponent(webKitDirName, isDirectory: true),
        fm: fm
      )
      networkBytes += webKitScan.sizeBytes
      networkFiles += webKitScan.fileCount
    }
    let urlCacheDisk = Int64(URLCache.shared.currentDiskUsage)
    let urlCacheMem = Int64(URLCache.shared.currentMemoryUsage)
    networkBytes = max(networkBytes, urlCacheDisk)
    if networkBytes > 0 && networkFiles == 0 {
      networkFiles = 1
    }

    var otherBytes: Int64 = 0
    var otherFiles = 0
    if let cachesRoot,
       let cacheEntries = try? fm.contentsOfDirectory(
         at: cachesRoot,
         includingPropertiesForKeys: nil,
         options: [.skipsHiddenFiles]
       )
    {
      for entry in cacheEntries {
        let name = entry.lastPathComponent
        if isKnownDedicatedCacheEntry(name, bundleId: bundleId) || isSystemManagedCacheEntry(name) {
          continue
        }
        let scan = scanItemStats(at: entry, fm: fm)
        otherBytes += scan.sizeBytes
        otherFiles += scan.fileCount
      }
    }

    var syncDbBytes: Int64 = 0
    if let sqliteDir = docsRoot?.appendingPathComponent("SQLite", isDirectory: true),
       let dbEntries = try? fm.contentsOfDirectory(
         at: sqliteDir,
         includingPropertiesForKeys: [.fileSizeKey],
         options: []
       )
    {
      for entry in dbEntries where entry.lastPathComponent.hasPrefix("mydrive_sync.db") {
        let scan = scanItemStats(at: entry, fm: fm)
        syncDbBytes += scan.sizeBytes
      }
    }

    let capacity = deviceStorageCapacity(fm: fm)

    return [
      "deviceTotalBytes": capacity.total,
      "deviceFreeBytes": capacity.free,
      "imageCache": [
        "sizeBytes": imageScan.sizeBytes,
        "fileCount": imageScan.fileCount,
      ],
      "videoCache": [
        "sizeBytes": videoScan.sizeBytes,
        "fileCount": videoScan.fileCount,
      ],
      "downloadsCache": [
        "sizeBytes": downloadsScan.sizeBytes,
        "fileCount": downloadsScan.fileCount,
        "items": topDownloads,
      ],
      "stagingCache": [
        "sizeBytes": stagingBytes,
        "fileCount": stagingFiles,
      ],
      "networkCache": [
        "sizeBytes": networkBytes,
        "fileCount": networkFiles,
        "memoryBytes": urlCacheMem,
      ],
      "otherCache": [
        "sizeBytes": otherBytes,
        "fileCount": otherFiles,
      ],
      "syncDatabaseBytes": syncDbBytes,
      "inspectedAt": isoString(Date()) ?? "",
    ]
  }

  private static func clearDirectoryChildren(at url: URL, fm: FileManager = FileManager()) -> (bytes: Int64, files: Int) {
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else {
      return (0, 0)
    }
    if !isDir.boolValue {
      let scan = scanItemStats(at: url, fm: fm)
      do {
        try fm.removeItem(at: url)
        return (scan.sizeBytes, scan.fileCount)
      } catch {
        return (0, 0)
      }
    }

    guard let children = try? fm.contentsOfDirectory(
      at: url,
      includingPropertiesForKeys: nil,
      options: []
    ) else {
      return (0, 0)
    }

    var deletedBytes: Int64 = 0
    var deletedFiles = 0
    for child in children {
      let scan = scanItemStats(at: child, fm: fm)
      do {
        try fm.removeItem(at: child)
        deletedBytes += scan.sizeBytes
        deletedFiles += scan.fileCount
      } catch {
        // Ignore locked in-flight system files.
      }
    }
    return (deletedBytes, deletedFiles)
  }

  @MainActor
  private static func clearWebKitCaches() async {
    let cacheTypes: Set<String> = [
      WKWebsiteDataTypeDiskCache,
      WKWebsiteDataTypeMemoryCache,
      WKWebsiteDataTypeOfflineWebApplicationCache,
      WKWebsiteDataTypeFetchCache,
    ]
    await WKWebsiteDataStore.default().removeData(
      ofTypes: cacheTypes,
      modifiedSince: .distantPast
    )
  }

  private static func clearDownloadsCache(fm: FileManager = FileManager()) -> (bytes: Int64, files: Int) {
    let downloadsDir = temporaryRootDirectory(fm: fm).appendingPathComponent(downloadsDirName, isDirectory: true)
    return clearDirectoryChildren(at: downloadsDir, fm: fm)
  }

  private static func clearStagingCache(fm: FileManager = FileManager()) -> (bytes: Int64, files: Int) {
    let tempRoot = temporaryRootDirectory(fm: fm)
    let cachesRoot = cachesRootDirectory(fm: fm)
    var totalBytes: Int64 = 0
    var totalFiles = 0

    let syncRes = clearDirectoryChildren(
      at: tempRoot.appendingPathComponent(syncStagingDirName, isDirectory: true),
      fm: fm
    )
    totalBytes += syncRes.bytes
    totalFiles += syncRes.files

    if let pickerDir = cachesRoot?.appendingPathComponent(documentPickerDirName, isDirectory: true) {
      let pickerRes = clearDirectoryChildren(at: pickerDir, fm: fm)
      totalBytes += pickerRes.bytes
      totalFiles += pickerRes.files
    }

    if let tempEntries = try? fm.contentsOfDirectory(
      at: tempRoot,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ) {
      for entry in tempEntries {
        let name = entry.lastPathComponent
        if name == downloadsDirName || name == syncStagingDirName {
          continue
        }
        let scan = scanItemStats(at: entry, fm: fm)
        do {
          try fm.removeItem(at: entry)
          totalBytes += scan.sizeBytes
          totalFiles += scan.fileCount
        } catch {
          // Skip files currently held open by the OS.
        }
      }
    }

    return (totalBytes, totalFiles)
  }

  private static func clearNetworkCache(fm: FileManager = FileManager()) async -> (bytes: Int64, files: Int) {
    let cachesRoot = cachesRootDirectory(fm: fm)
    let bundleId = Bundle.main.bundleIdentifier
    var beforeBundleBytes: Int64 = 0
    var beforeBundleFiles = 0
    if let cachesRoot, let bundleId, !bundleId.isEmpty {
      let bundleDir = cachesRoot.appendingPathComponent(bundleId, isDirectory: true)
      let beforeScan = scanItemStats(at: bundleDir, fm: fm)
      beforeBundleBytes = beforeScan.sizeBytes
      beforeBundleFiles = beforeScan.fileCount
    }

    let beforeUrlDisk = Int64(URLCache.shared.currentDiskUsage)
    URLCache.shared.removeAllCachedResponses()
    await clearWebKitCaches()

    var totalBytes: Int64 = 0
    var totalFiles = 0
    if let cachesRoot {
      if let bundleId, !bundleId.isEmpty {
        let bundleDir = cachesRoot.appendingPathComponent(bundleId, isDirectory: true)
        let fsCached = bundleDir.appendingPathComponent("fsCachedData", isDirectory: true)
        let fsRes = clearDirectoryChildren(at: fsCached, fm: fm)
        let afterScan = scanItemStats(at: bundleDir, fm: fm)
        let deltaBytes = max(fsRes.bytes, max(0, beforeBundleBytes - afterScan.sizeBytes))
        let deltaFiles = max(fsRes.files, max(0, beforeBundleFiles - afterScan.fileCount))
        let urlCacheDelta = max(0, beforeUrlDisk - Int64(URLCache.shared.currentDiskUsage))
        totalBytes += max(deltaBytes, urlCacheDelta)
        totalFiles += deltaFiles
      } else {
        totalBytes += max(0, beforeUrlDisk - Int64(URLCache.shared.currentDiskUsage))
      }
      let webKitDir = cachesRoot.appendingPathComponent(webKitDirName, isDirectory: true)
      let wkRes = clearDirectoryChildren(at: webKitDir, fm: fm)
      totalBytes += wkRes.bytes
      totalFiles += wkRes.files
    } else {
      totalBytes += max(0, beforeUrlDisk - Int64(URLCache.shared.currentDiskUsage))
    }

    return (totalBytes, totalFiles)
  }

  private static func clearOtherAppCache(fm: FileManager = FileManager()) -> (bytes: Int64, files: Int) {
    let bundleId = Bundle.main.bundleIdentifier
    guard let cachesRoot = cachesRootDirectory(fm: fm),
          let cacheEntries = try? fm.contentsOfDirectory(
            at: cachesRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
          )
    else {
      return (0, 0)
    }

    var totalBytes: Int64 = 0
    var totalFiles = 0
    for entry in cacheEntries {
      let name = entry.lastPathComponent
      if isKnownDedicatedCacheEntry(name, bundleId: bundleId) || isSystemManagedCacheEntry(name) {
        continue
      }
      let scan = scanItemStats(at: entry, fm: fm)
      do {
        try fm.removeItem(at: entry)
        totalBytes += scan.sizeBytes
        totalFiles += scan.fileCount
      } catch {
        // Ignore non-deletable system cache files.
      }
    }
    return (totalBytes, totalFiles)
  }

  private static func clearNativeCacheCategory(_ category: String) async -> [String: Any] {
    let fm = FileManager()
    var totalBytes: Int64 = 0
    var totalFiles = 0

    switch category {
    case "downloads":
      let res = clearDownloadsCache(fm: fm)
      totalBytes += res.bytes
      totalFiles += res.files
    case "staging":
      let res = clearStagingCache(fm: fm)
      totalBytes += res.bytes
      totalFiles += res.files
    case "network":
      let res = await clearNetworkCache(fm: fm)
      totalBytes += res.bytes
      totalFiles += res.files
    case "other":
      let res = clearOtherAppCache(fm: fm)
      totalBytes += res.bytes
      totalFiles += res.files
    case "all_native":
      let dlRes = clearDownloadsCache(fm: fm)
      let stRes = clearStagingCache(fm: fm)
      let netRes = await clearNetworkCache(fm: fm)
      let otherRes = clearOtherAppCache(fm: fm)
      totalBytes = dlRes.bytes + stRes.bytes + netRes.bytes + otherRes.bytes
      totalFiles = dlRes.files + stRes.files + netRes.files + otherRes.files
    default:
      break
    }

    return [
      "deletedBytes": totalBytes,
      "deletedFiles": totalFiles,
    ]
  }

  private static func removeSingleSafeCachedFile(filePath: String) -> [String: Any] {
    guard !filePath.isEmpty else {
      return ["deletedBytes": Int64(0), "deletedFiles": 0]
    }
    let fm = FileManager()
    let tempRoot = temporaryRootDirectory(fm: fm)
    let downloadsRoot = tempRoot.appendingPathComponent(downloadsDirName, isDirectory: true)
    let syncStagingRoot = tempRoot.appendingPathComponent(syncStagingDirName, isDirectory: true)
    var allowedRoots: [URL] = [downloadsRoot, syncStagingRoot]
    if let pickerRoot = cachesRootDirectory(fm: fm)?.appendingPathComponent(documentPickerDirName, isDirectory: true) {
      allowedRoots.append(pickerRoot)
    }

    let targetUrl = resolveLocalFileURL(filePath).resolvingSymlinksInPath().standardizedFileURL
    let targetPath = targetUrl.path
    let normalizedRoots = allowedRoots.map { url -> String in
      let p = url.resolvingSymlinksInPath().standardizedFileURL.path
      return p.hasSuffix("/") ? p : "\(p)/"
    }
    guard normalizedRoots.contains(where: { targetPath.hasPrefix($0) }) else {
      return ["deletedBytes": Int64(0), "deletedFiles": 0]
    }

    let scan = scanItemStats(at: targetUrl, fm: fm)
    do {
      try fm.removeItem(at: targetUrl)
      // Clean empty UUID parent folders inside mydrive-downloads.
      let downloadsRaw = downloadsRoot.resolvingSymlinksInPath().standardizedFileURL.path
      let downloadsPrefix = downloadsRaw.hasSuffix("/") ? downloadsRaw : "\(downloadsRaw)/"
      let parentUrl = targetUrl.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
      if parentUrl.path.hasPrefix(downloadsPrefix),
         let remaining = try? fm.contentsOfDirectory(atPath: parentUrl.path),
         remaining.isEmpty
      {
        try? fm.removeItem(at: parentUrl)
      }
      return [
        "deletedBytes": scan.sizeBytes,
        "deletedFiles": max(1, scan.fileCount),
      ]
    } catch {
      return ["deletedBytes": Int64(0), "deletedFiles": 0]
    }
  }

  private static func pruneExpiredTempFiles(
    maxAgeSeconds: Double,
    includeSyncStaging: Bool
  ) -> [String: Any] {
    let fm = FileManager()
    let cutoff = Date().addingTimeInterval(-max(0, maxAgeSeconds))
    let tempRoot = temporaryRootDirectory(fm: fm)
    var targetDirs: [URL] = [
      tempRoot.appendingPathComponent(downloadsDirName, isDirectory: true),
    ]
    if let pickerDir = cachesRootDirectory(fm: fm)?.appendingPathComponent(documentPickerDirName, isDirectory: true) {
      targetDirs.append(pickerDir)
    }
    if includeSyncStaging {
      targetDirs.append(tempRoot.appendingPathComponent(syncStagingDirName, isDirectory: true))
    }

    var deletedBytes: Int64 = 0
    var deletedFiles = 0
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]

    for rootDir in targetDirs {
      guard fm.fileExists(atPath: rootDir.path),
            let enumerator = fm.enumerator(at: rootDir, includingPropertiesForKeys: Array(keys), options: [])
      else {
        continue
      }
      var expiredFiles: [(url: URL, size: Int64)] = []
      var subdirs: [URL] = []
      while let entry = enumerator.nextObject() as? URL {
        guard let values = try? entry.resourceValues(forKeys: keys) else { continue }
        if values.isRegularFile == true {
          let modDate = values.contentModificationDate ?? Date.distantPast
          if modDate <= cutoff {
            expiredFiles.append((url: entry, size: Int64(values.fileSize ?? 0)))
          }
        } else {
          subdirs.append(entry)
        }
      }
      for item in expiredFiles {
        do {
          try fm.removeItem(at: item.url)
          deletedBytes += item.size
          deletedFiles += 1
        } catch {
          // Ignore locked files.
        }
      }
      // Remove empty subdirectories bottom-up.
      for dir in subdirs.reversed() {
        if let contents = try? fm.contentsOfDirectory(atPath: dir.path), contents.isEmpty {
          try? fm.removeItem(at: dir)
        }
      }
    }

    return [
      "deletedBytes": deletedBytes,
      "deletedFiles": deletedFiles,
    ]
  }
}
