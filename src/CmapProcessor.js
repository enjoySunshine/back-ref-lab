import { binarySearch } from './utils';
import { getEncoding, getEncodingMapping } from './encodings';
import { cache } from './cache';
import { range } from './utils';

export default class CmapProcessor {
  constructor(cmapTable) {
    // Attempt to find a Unicode cmap first
    this.encoding = null;
    this.cmap = this.findSubtable(cmapTable, [
      // 32-bit subtables
      [3, 10],
      [0, 6],
      [0, 4],

      // 16-bit subtables
      [3, 1],
      [0, 3],
      [0, 2],
      [0, 1],
      [0, 0],
    ]);

    // If not unicode cmap was found, take the first table with a supported encoding.
    if (!this.cmap) {
      for (let cmap of cmapTable.tables) {
        let encoding = getEncoding(
          cmap.platformID,
          cmap.encodingID,
          cmap.table.language - 1,
        );
        let mapping = getEncodingMapping(encoding);
        if (mapping) {
          this.cmap = cmap.table;
          this.encoding = mapping;
        }
      }
    }

    if (!this.cmap) {
      throw new Error('Could not find a supported cmap table');
    }

    this.uvs = this.findSubtable(cmapTable, [[0, 5]]);
    if (this.uvs && this.uvs.version !== 14) {
      this.uvs = null;
    }
  }

  findSubtable(cmapTable, pairs) {
    for (let [platformID, encodingID] of pairs) {
      for (let cmap of cmapTable.tables) {
        if (cmap.platformID === platformID && cmap.encodingID === encodingID) {
          return cmap.table;
        }
      }
    }

    return null;
  }

  lookup(codepoint, variationSelector) {
    // If there is no Unicode cmap in this font, we need to re-encode
    // the codepoint in the encoding that the cmap supports.
    if (this.encoding) {
      // ASCII is shared by all supported legacy encodings. Other code points
      // have no glyph unless the encoding can represent them.
      if (codepoint >= 0x80) {
        codepoint = this.encoding.get(codepoint);
        if (!codepoint) {
          return 0;
        }
      }

      // Otherwise, try to get a Unicode variation selector for this codepoint if one is provided.
    } else if (variationSelector) {
      let gid = this.getVariationSelector(codepoint, variationSelector);
      if (gid) {
        return gid;
      }
    }

    return this._lookupCode(codepoint);
  }

  // Maps a code in the selected cmap subtable to a glyph id, or 0 if unmapped
  _lookupCode(codepoint) {
    let cmap = this.cmap;
    switch (cmap.version) {
      case 0:
        return cmap.codeMap.get(codepoint) || 0;

      case 4: {
        let min = 0;
        let max = cmap.segCount - 1;
        while (min <= max) {
          let mid = (min + max) >> 1;

          if (codepoint < cmap.startCode.get(mid)) {
            max = mid - 1;
          } else if (codepoint > cmap.endCode.get(mid)) {
            min = mid + 1;
          } else {
            let rangeOffset = cmap.idRangeOffset.get(mid);
            let gid;

            if (rangeOffset === 0) {
              gid = codepoint + cmap.idDelta.get(mid);
            } else {
              let index =
                rangeOffset / 2 +
                (codepoint - cmap.startCode.get(mid)) -
                (cmap.segCount - mid);
              gid = cmap.glyphIndexArray.get(index) || 0;
              if (gid !== 0) {
                gid += cmap.idDelta.get(mid);
              }
            }

            return gid & 0xffff;
          }
        }

        return 0;
      }

      case 8:
        throw new Error('TODO: cmap format 8');

      case 6:
      case 10:
        return cmap.glyphIndices.get(codepoint - cmap.firstCode) || 0;

      case 12:
      case 13: {
        let min = 0;
        let max = cmap.nGroups - 1;
        while (min <= max) {
          let mid = (min + max) >> 1;
          let group = cmap.groups.get(mid);

          if (codepoint < group.startCharCode) {
            max = mid - 1;
          } else if (codepoint > group.endCharCode) {
            min = mid + 1;
          } else {
            if (cmap.version === 12) {
              return group.glyphID + (codepoint - group.startCharCode);
            } else {
              return group.glyphID;
            }
          }
        }

        return 0;
      }

      case 14:
        throw new Error('TODO: cmap format 14');

      default:
        throw new Error(`Unknown cmap format ${cmap.version}`);
    }
  }

  getVariationSelector(codepoint, variationSelector) {
    if (!this.uvs) {
      return 0;
    }

    let selectors = this.uvs.varSelectors.toArray();
    let i = binarySearch(selectors, (x) => variationSelector - x.varSelector);
    if (i === -1) {
      return 0;
    }

    let sel = selectors[i];

    // A sequence in the default UVS table uses the glyph from the regular cmap
    if (
      sel.defaultUVS &&
      binarySearch(sel.defaultUVS, (x) =>
        codepoint < x.startUnicodeValue
          ? -1
          : codepoint > x.startUnicodeValue + x.additionalCount
            ? +1
            : 0,
      ) !== -1
    ) {
      return 0;
    }

    if (sel.nonDefaultUVS) {
      i = binarySearch(sel.nonDefaultUVS, (x) => codepoint - x.unicodeValue);
      if (i !== -1) {
        return sel.nonDefaultUVS[i].glyphID;
      }
    }

    return 0;
  }

  getCharacterSet() {
    // Codes that map to glyph 0 (.notdef) are not supported characters
    return this._getCodes().filter((code) => this._lookupCode(code) !== 0);
  }

  _getCodes() {
    let cmap = this.cmap;
    switch (cmap.version) {
      case 0:
        return range(0, cmap.codeMap.length);

      case 4: {
        let res = [];
        let endCodes = cmap.endCode.toArray();
        for (let i = 0; i < endCodes.length; i++) {
          let tail = endCodes[i] + 1;
          let start = cmap.startCode.get(i);
          res.push(...range(start, tail));
        }

        return res;
      }

      case 8:
        throw new Error('TODO: cmap format 8');

      case 6:
      case 10:
        return range(cmap.firstCode, cmap.firstCode + cmap.glyphIndices.length);

      case 12:
      case 13: {
        let res = [];
        for (let group of cmap.groups.toArray()) {
          res.push(...range(group.startCharCode, group.endCharCode + 1));
        }

        return res;
      }

      case 14:
        throw new Error('TODO: cmap format 14');

      default:
        throw new Error(`Unknown cmap format ${cmap.version}`);
    }
  }

  // Inverts the cmap in one pass. Looking a glyph up in this index is O(1),
  // unlike rescanning the whole cmap for every glyph id.
  _buildReverseIndex() {
    let cmap = this.cmap;
    let index = new Map();
    let add = (gid, codepoint) => {
      let codePoints = index.get(gid);
      if (codePoints === undefined) {
        codePoints = [];
        index.set(gid, codePoints);
      }

      codePoints.push(codepoint);
    };

    switch (cmap.version) {
      case 0: {
        for (let i = 0; i < 256; i++) {
          let gid = cmap.codeMap.get(i);
          if (gid !== undefined) {
            add(gid, i);
          }
        }

        break;
      }

      case 4: {
        for (let i = 0; i < cmap.segCount; i++) {
          let end = cmap.endCode.get(i);
          let start = cmap.startCode.get(i);
          let rangeOffset = cmap.idRangeOffset.get(i);
          let delta = cmap.idDelta.get(i);

          for (let c = start; c <= end; c++) {
            let g = 0;
            if (rangeOffset === 0) {
              g = c + delta;
            } else {
              let index = rangeOffset / 2 + (c - start) - (cmap.segCount - i);
              g = cmap.glyphIndexArray.get(index) || 0;
              if (g !== 0) {
                g += delta;
              }
            }

            add(g & 0xffff, c);
          }
        }

        break;
      }

      case 6:
      case 10: {
        for (let i = 0; i < cmap.glyphIndices.length; i++) {
          let gid = cmap.glyphIndices.get(i);
          if (gid !== undefined) {
            add(gid, cmap.firstCode + i);
          }
        }

        break;
      }

      case 12: {
        for (let group of cmap.groups.toArray()) {
          let code = group.startCharCode;
          let gid = group.glyphID;
          for (let end = group.endCharCode; code <= end; code++, gid++) {
            add(gid, code);
          }
        }

        break;
      }

      case 13: {
        for (let group of cmap.groups.toArray()) {
          for (let code of range(group.startCharCode, group.endCharCode + 1)) {
            add(group.glyphID, code);
          }
        }

        break;
      }

      default:
        throw new Error(`Unknown cmap format ${cmap.version}`);
    }

    return index;
  }

  codePointsForGlyph(gid) {
    if (!this._reverseIndex) {
      this._reverseIndex = this._buildReverseIndex();
    }

    return this._reverseIndex.get(gid) || [];
  }
}

cache(CmapProcessor, {
  getCharacterSet: 'once',
  codePointsForGlyph: 'key',
});
