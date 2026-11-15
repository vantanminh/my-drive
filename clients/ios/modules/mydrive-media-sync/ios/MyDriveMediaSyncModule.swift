import CryptoKit
import ExpoModulesCore
import Foundation
import Photos
import UniformTypeIdentifiers

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

      Task.detached(priority: .userInitiated) {
        do {
          let finalOffset = try await Self.performChunkedUpload(
            baseUrl: baseUrl,
            uploadId: uploadId,
            fileUri: fileUri,
            startOffset: startOffset,
            chunkSize: chunkSize,
            csrfToken: csrfToken
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

    AsyncFunction("downloadToLocalFile") { (urlString: String, filename: String, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        guard let url = URL(string: urlString) else {
          promise.reject(MediaSyncOperationException(("INVALID_URL", "Invalid download URL.")))
          return
        }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = true
        request.timeoutInterval = 300

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
    csrfToken: String?
  ) async -> UInt64? {
    var headRequest = URLRequest(url: patchURL)
    headRequest.httpMethod = "HEAD"
    headRequest.httpShouldHandleCookies = true
    headRequest.timeoutInterval = 20
    headRequest.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
    if let csrf = csrfToken, !csrf.isEmpty {
      headRequest.setValue(csrf, forHTTPHeaderField: "X-Csrf-Token")
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
    let maxChunk: UInt64 = 8 * 1024 * 1024
    var adaptiveChunk = UInt64(min(Int(maxChunk), max(Int(minChunk), Int(chunkSize))))
    let resolvedCsrf = resolveCsrfToken(explicit: csrfToken, for: patchURL)

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
            csrfToken: resolvedCsrf
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
            csrfToken: resolvedCsrf
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
            csrfToken: resolvedCsrf
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
}
