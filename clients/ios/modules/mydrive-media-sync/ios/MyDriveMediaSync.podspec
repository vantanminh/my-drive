Pod::Spec.new do |s|
  s.name           = 'MyDriveMediaSync'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS PhotoKit iCloud original resolver, SHA-256 hasher, and streaming transfer module for MyDrive'
  s.description    = 'Checks iCloud optimized storage state via PhotoKit, downloads full-resolution originals from iCloud, computes streaming SHA-256 digests with CryptoKit, and streams TUS-offset chunks via URLSession.'
  s.author         = 'MyDrive Contributors'
  s.homepage       = 'https://github.com/vantanminh/my-drive'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.frameworks     = 'Photos', 'CryptoKit', 'UniformTypeIdentifiers', 'WebKit'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,swift}'
end
