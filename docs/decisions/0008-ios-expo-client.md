---
created_at: "2026-11-14T17:06:07.684788900+00:00"
doc: docs/decisions/0008-ios-expo-client.md
id: "0008"
links:
  - IN-039
  - US-042
notes: "Uses custom NAS URL validation, session+CSRF auth via POST /api/auth/login, Drive/Photos/Preview/Download/Upload APIs, a local Expo Swift module using PHAssetResourceManager + PHImageManager with isNetworkAccessAllowed=true for iCloud optimized storage originals, and GitHub Actions macOS Xcode archive/IPA code signing."
status: accepted
title: Expo iOS companion app with native PhotoKit iCloud original sync and GitHub Actions signing
type: decision
updated_at: "2026-11-14T17:06:07.684792900+00:00"
verify: null
---

# Expo iOS companion app with native PhotoKit iCloud original sync and GitHub Actions signing
