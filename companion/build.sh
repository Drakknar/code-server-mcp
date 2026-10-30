#!/bin/sh
# Packs src/ into a .vsix next to this script: the same package as build.ps1, for the image build. Needs node and zip.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
field() { node -p "require('$here/src/package.json').$1"; }
name=$(field name); version=$(field version); publisher=$(field publisher)
out="$here/$publisher.$name-$version.vsix"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/extension"
cp "$here"/src/* "$tmp/extension/"
cat > "$tmp/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="$publisher" />
    <DisplayName>$(field displayName)</DisplayName>
    <Description xml:space="preserve">$(field description)</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(field engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
EOF
cat > "$tmp/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
EOF
(cd "$tmp" && zip -qX "$out" '[Content_Types].xml' extension.vsixmanifest extension/*)
echo "$out"
