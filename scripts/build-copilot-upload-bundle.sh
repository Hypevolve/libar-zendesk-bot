#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/docs/copilot/knowledge-base"
OUT_DIR="$ROOT_DIR/dist/copilot-upload-bundle"
TXT_DIR="$OUT_DIR/txt"
DOCX_DIR="$OUT_DIR/docx"
GUIDE_DIR="$OUT_DIR/guides"
ZIP_PATH="$ROOT_DIR/dist/libar-copilot-upload-bundle.zip"

rm -rf "$OUT_DIR"
mkdir -p "$TXT_DIR" "$DOCX_DIR" "$GUIDE_DIR"

cp "$SRC_DIR"/*.txt "$TXT_DIR"/
cp "$ROOT_DIR/docs/copilot/"*.md "$GUIDE_DIR"/
cp "$ROOT_DIR/docs/copilot/"*.txt "$GUIDE_DIR"/

for file in "$SRC_DIR"/*.txt; do
  base_name="$(basename "${file%.txt}")"
  textutil -convert docx "$file" -output "$DOCX_DIR/$base_name.docx"
done

find "$OUT_DIR" -name '._*' -delete

rm -f "$ZIP_PATH"
(
  cd "$ROOT_DIR/dist"
  COPYFILE_DISABLE=1
  export COPYFILE_DISABLE
  zip -qr "$(basename "$ZIP_PATH")" "$(basename "$OUT_DIR")"
)

echo "Copilot upload bundle generated:"
echo "  TXT:  $TXT_DIR"
echo "  DOCX: $DOCX_DIR"
echo "  ZIP:  $ZIP_PATH"
