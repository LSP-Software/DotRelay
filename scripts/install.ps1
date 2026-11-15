# Installs the DotRelay CLI (dotrelay.exe) from a GitHub release.
#
#   irm https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.ps1 | iex
#
# Environment:
#   DOTRELAY_VERSION       release to install, such as 1.2.3 or v1.2.3-alpha.1
#                          (default: the latest stable release)
#   DOTRELAY_INSTALL_DIR   directory for the binary
#                          (default: %LOCALAPPDATA%\DotRelay\bin)
#   DOTRELAY_DOWNLOAD_BASE releases URL to download from
#                          (default: https://github.com/LSP-Software/DotRelay/releases)
#
# The archive is checked against the release's SHA256SUMS before anything is
# installed. Works in Windows PowerShell 5.1 and PowerShell 7, needs no
# administrator rights, and sends nothing but the downloads. Errors are thrown
# rather than calling exit, so `irm | iex` never closes the caller's shell.

function Install-DotRelay {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version 3.0

  $base = 'https://github.com/LSP-Software/DotRelay/releases'
  if ($env:DOTRELAY_DOWNLOAD_BASE) { $base = $env:DOTRELAY_DOWNLOAD_BASE }
  $base = $base.TrimEnd('/')
  $tagPattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'

  # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  if ($env:OS -ne 'Windows_NT') {
    throw 'dotrelay install: install.ps1 is for Windows. On Linux and macOS run: curl -fsSL https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.sh | sh'
  }
  # A 32-bit PowerShell on 64-bit Windows reports the real CPU here.
  $machine = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $machine = $env:PROCESSOR_ARCHITEW6432 }
  if ($machine -ne 'AMD64') {
    throw "dotrelay install: DotRelay publishes a Windows binary for x64 only; this machine is $machine. See https://github.com/LSP-Software/DotRelay/releases"
  }
  $target = 'win32-x64'

  if ($env:DOTRELAY_VERSION) {
    $tag = 'v' + ($env:DOTRELAY_VERSION -replace '^v', '')
    if ($tag -notmatch $tagPattern) {
      throw "dotrelay install: DOTRELAY_VERSION must be a release version such as 1.2.3 or v1.2.3-alpha.1 (got $env:DOTRELAY_VERSION)"
    }
  } else {
    # The latest stable release, from the tag GitHub redirects /releases/latest to.
    try {
      $response = Invoke-WebRequest -Uri "$base/latest" -UseBasicParsing
    } catch {
      throw "dotrelay install: could not reach $base/latest ($($_.Exception.Message))"
    }
    if ($response.BaseResponse.PSObject.Properties['ResponseUri']) {
      $final = $response.BaseResponse.ResponseUri.AbsoluteUri
    } else {
      $final = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    }
    $tag = ($final.TrimEnd('/') -split '/')[-1]
    if ($tag -notmatch $tagPattern) {
      throw "dotrelay install: found no stable release at $base/latest. Set DOTRELAY_VERSION to install a prerelease, for example `$env:DOTRELAY_VERSION = 'v0.1.0-alpha.1'"
    }
  }

  $installDir = $env:DOTRELAY_INSTALL_DIR
  if (-not $installDir) {
    if (-not $env:LOCALAPPDATA) {
      throw 'dotrelay install: LOCALAPPDATA is not set; set DOTRELAY_INSTALL_DIR to the directory for dotrelay.exe'
    }
    $installDir = Join-Path $env:LOCALAPPDATA 'DotRelay\bin'
  }

  $archive = "dotrelay-$tag-$target.zip"
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('dotrelay-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    Write-Host "downloading dotrelay $tag for $target"
    foreach ($name in @($archive, 'SHA256SUMS')) {
      $url = "$base/download/$tag/$name"
      try {
        Invoke-WebRequest -Uri $url -OutFile (Join-Path $temp $name) -UseBasicParsing
      } catch {
        throw "dotrelay install: download failed: $url ($($_.Exception.Message))"
      }
    }

    $expected = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $temp 'SHA256SUMS')) {
      $fields = $line.Trim() -split '\s+'
      if ($fields.Count -eq 2 -and $fields[1] -eq $archive) { $expected = $fields[0].ToLowerInvariant() }
    }
    if (-not $expected -or $expected -notmatch '^[0-9a-f]{64}$') {
      throw "dotrelay install: SHA256SUMS for $tag has no valid checksum for $archive"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $temp $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "dotrelay install: checksum mismatch for ${archive}: expected $expected, got $actual. Nothing was installed."
    }
    Write-Host "verified SHA-256 $actual"

    $extract = Join-Path $temp 'extract'
    Expand-Archive -LiteralPath (Join-Path $temp $archive) -DestinationPath $extract
    $binary = Join-Path $extract 'dotrelay.exe'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
      throw "dotrelay install: $archive does not contain dotrelay.exe"
    }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $destination = Join-Path $installDir 'dotrelay.exe'
    try {
      Copy-Item -LiteralPath $binary -Destination $destination -Force
    } catch {
      throw "dotrelay install: could not write $destination. Close any running dotrelay and try again, or set DOTRELAY_INSTALL_DIR. ($($_.Exception.Message))"
    }

    $version = & $destination --version
    if ($LASTEXITCODE -ne 0) {
      throw "dotrelay install: installed $destination, but it does not run on this machine"
    }
    Write-Host "installed dotrelay $version to $destination"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = @("$userPath;$env:Path" -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $installDir.TrimEnd('\')) }).Count -gt 0
    if (-not $onPath) {
      Write-Host ''
      Write-Host "$installDir is not on your PATH. Add it for your user and open a new terminal:"
      Write-Host ''
      Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$installDir', 'User')"
    }
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-DotRelay
