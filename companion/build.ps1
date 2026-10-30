# Packs src/ into a .vsix next to this script (no vsce/Node needed). Run with PowerShell 7.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$pkg = Get-Content "$PSScriptRoot/src/package.json" -Raw | ConvertFrom-Json
$out = "$PSScriptRoot/$($pkg.publisher).$($pkg.name)-$($pkg.version).vsix"
Get-ChildItem $PSScriptRoot -Filter *.vsix | Remove-Item

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($pkg.name)" Version="$($pkg.version)" Publisher="$($pkg.publisher)" />
    <DisplayName>$($pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$($pkg.description)</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"@
$types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>'

$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($e in @(@('[Content_Types].xml', $types), @('extension.vsixmanifest', $manifest))) {
    $w = New-Object System.IO.StreamWriter(($zip.CreateEntry($e[0])).Open())
    $w.Write($e[1]); $w.Close()
  }
  foreach ($f in Get-ChildItem "$PSScriptRoot/src" -File) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, "extension/$($f.Name)")
  }
} finally { $zip.Dispose() }
Write-Output $out
