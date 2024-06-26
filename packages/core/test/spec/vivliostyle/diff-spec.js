/**
 * Copyright 2017 Daishinsha Inc.
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 */

import * as vivliostyle_diff from "../../../src/vivliostyle/diff";

describe("diff", function () {
  describe("#diff", function () {
    it("calculates differences of two blocks of text.", function () {
      expect(vivliostyle_diff.diffChars("aあb", "aあb")).toEqual([[0, "aあb"]]);
      expect(vivliostyle_diff.diffChars("aあb", "axあいうb")).toEqual([
        [0, "a"],
        [1, "x"],
        [0, "あ"],
        [1, "いう"],
        [0, "b"],
      ]);
      expect(vivliostyle_diff.diffChars("aあb", "xxaあbいう")).toEqual([
        [1, "xx"],
        [0, "aあb"],
        [1, "いう"],
      ]);
      expect(vivliostyle_diff.diffChars("axあいうb", "aあb")).toEqual([
        [0, "a"],
        [-1, "x"],
        [0, "あ"],
        [-1, "いう"],
        [0, "b"],
      ]);
      expect(vivliostyle_diff.diffChars("xxaあbいう", "aあb")).toEqual([
        [-1, "xx"],
        [0, "aあb"],
        [-1, "いう"],
      ]);

      expect(vivliostyle_diff.diffChars("abc", "efg")).toEqual([
        [-1, "abc"],
        [1, "efg"],
      ]);
      expect(vivliostyle_diff.diffChars("aabbaacc", "aaabacc")).toEqual([
        [0, "aa"],
        [-1, "b"],
        [1, "a"],
        [0, "b"],
        [-1, "a"],
        [0, "acc"],
      ]);
    });
  });

  describe("#restoreOriginalText", function () {
    it("restores the old text from changes.", function () {
      var diff = vivliostyle_diff.diffChars("aあb", "aあb");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("aあb", "axあいうb");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("aあb", "xxaあbいう");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("axあいうb", "aあb");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("axあいうb");

      diff = vivliostyle_diff.diffChars("xxaあbいう", "aあb");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("xxaあbいう");

      diff = vivliostyle_diff.diffChars("abc", "efg");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("abc");

      diff = vivliostyle_diff.diffChars("aabbaacc", "aaabacc");
      expect(vivliostyle_diff.restoreOriginalText(diff)).toEqual("aabbaacc");
    });
  });

  describe("#restoreNewText", function () {
    it("restores the new text from changes.", function () {
      var diff = vivliostyle_diff.diffChars("aあb", "aあb");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("aあb", "axあいうb");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("axあいうb");

      diff = vivliostyle_diff.diffChars("aあb", "xxaあbいう");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("xxaあbいう");

      diff = vivliostyle_diff.diffChars("axあいうb", "aあb");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("xxaあbいう", "aあb");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("aあb");

      diff = vivliostyle_diff.diffChars("abc", "efg");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("efg");

      diff = vivliostyle_diff.diffChars("aabbaacc", "aaabacc");
      expect(vivliostyle_diff.restoreNewText(diff)).toEqual("aaabacc");
    });
  });

  describe("#resolveNewIndex", function () {
    it("resolves new index from old index.", function () {
      var diff = vivliostyle_diff.diffChars("abc", "a-b-c");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(4);

      diff = vivliostyle_diff.diffChars("a-b-c", "abc");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(2);

      diff = vivliostyle_diff.diffChars("あいう", "漢あいう字");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(3);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(4);

      diff = vivliostyle_diff.diffChars("漢あいう字", "あいう");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(2);

      diff = vivliostyle_diff.diffChars("aabb--cc", "aa--bbcc");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(6);
      expect(vivliostyle_diff.resolveNewIndex(diff, 7)).toBe(7);
      expect(vivliostyle_diff.resolveNewIndex(diff, 8)).toBe(7);
      expect(vivliostyle_diff.resolveNewIndex(diff, 9)).toBe(7);

      diff = vivliostyle_diff.diffChars("aa--bbcc", "aabb--cc");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(5);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(6);
      expect(vivliostyle_diff.resolveNewIndex(diff, 7)).toBe(7);
      expect(vivliostyle_diff.resolveNewIndex(diff, 8)).toBe(7);
      expect(vivliostyle_diff.resolveNewIndex(diff, 9)).toBe(7);

      diff = vivliostyle_diff.diffChars("あいう漢字", "漢字えお");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(1);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(3);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(3);

      diff = vivliostyle_diff.diffChars("漢字えお", "あいう漢字");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(3);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(4);

      diff = vivliostyle_diff.diffChars("abc", "fghij");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(4);

      diff = vivliostyle_diff.diffChars("fghij", "abc");
      expect(vivliostyle_diff.resolveNewIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 2)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 3)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 4)).toBe(0);
      expect(vivliostyle_diff.resolveNewIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveNewIndex(diff, 6)).toBe(2);
    });
  });

  describe("#resolveOriginalIndex", function () {
    it("resolves original index from new index.", function () {
      var diff = vivliostyle_diff.diffChars("abc", "a-b-c");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(2);

      diff = vivliostyle_diff.diffChars("a-b-c", "abc");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(4);

      diff = vivliostyle_diff.diffChars("あいう", "漢あいう字");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(2);

      diff = vivliostyle_diff.diffChars("漢あいう字", "あいう");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(3);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(4);

      diff = vivliostyle_diff.diffChars("aabb--cc", "aa--bbcc");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(3);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(6);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 7)).toBe(7);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 8)).toBe(7);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 9)).toBe(7);

      diff = vivliostyle_diff.diffChars("aa--bbcc", "aabb--cc");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(3);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(6);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 7)).toBe(7);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 8)).toBe(7);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 9)).toBe(7);

      diff = vivliostyle_diff.diffChars("あいう漢字", "漢字えお");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(3);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(4);

      diff = vivliostyle_diff.diffChars("漢字えお", "あいう漢字");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(0);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(1);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(3);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(3);

      diff = vivliostyle_diff.diffChars("abc", "fghij");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 5)).toBe(2);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 6)).toBe(2);

      diff = vivliostyle_diff.diffChars("fghij", "abc");
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 0)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 1)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 2)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 3)).toBe(4);
      expect(vivliostyle_diff.resolveOriginalIndex(diff, 4)).toBe(4);
    });
  });
});
