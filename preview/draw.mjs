import fs from 'node:fs';
import { openSync } from 'fontkit';

const font = openSync(
  new URL(
    '../test/data/NotoSansCJK/NotoSansCJKkr-Regular.otf',
    import.meta.url,
  ),
);

// U+2F00 (KANGXI RADICAL ONE) and U+4E00 (CJK UNIFIED IDEOGRAPH-4E00) are
// different characters that share glyph 9831 in this font.
const glyphs = [0x2f00, 0x4e00].map((codePoint) =>
  font.glyphForCodePoint(codePoint),
);
const glyphId = glyphs[0].id;

for (const glyph of glyphs) {
  if (glyph.id !== 9831 || glyph.advanceWidth !== 1000) {
    throw new Error(
      `expected glyph 9831 with advance 1000, got ${glyph.id} with advance ${glyph.advanceWidth}`,
    );
  }
}

// Two strokes side by side: each advances by its own 1000, so together they
// span 2000 without changing a single stroke's advance.
const box = glyphs[0].path.bbox;
const width = glyphs[0].advanceWidth + glyphs[1].advanceWidth;
const height = Math.max(1, Math.ceil(box.maxY - box.minY));
const paths = glyphs
  .map((glyph, i) => {
    const x = i * glyph.advanceWidth;
    return `<g transform="translate(${x}, ${-box.maxY}) scale(1,-1)"><path d="${glyph.path.toSVG()}" fill="#f4f1ea"/></g>`;
  })
  .join('\n  ');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-box.maxY} ${width} ${height}" width="480" height="480">
  <rect x="0" y="${-box.maxY}" width="${width}" height="${height}" fill="#111"/>
  ${paths}
</svg>
`;
fs.writeFileSync(new URL('./out.svg', import.meta.url), svg);
console.log(
  'wrote preview/out.svg',
  glyphId,
  glyphs.map((glyph) => glyph.advanceWidth),
  width,
);
