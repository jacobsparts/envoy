(function webpackUniversalModuleDefinition(root, factory) {
	if(typeof exports === 'object' && typeof module === 'object')
		module.exports = factory();
	else if(typeof define === 'function' && define.amd)
		define([], factory);
	else if(typeof exports === 'object')
		exports["SerializeAddon"] = factory();
	else
		root["SerializeAddon"] = factory();
})(globalThis, () => {
return /******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "../../out/browser/Types.js"
/*!**********************************!*\
  !*** ../../out/browser/Types.js ***!
  \**********************************/
(__unused_webpack_module, exports, __webpack_require__) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DEFAULT_ANSI_COLORS = void 0;
const Color_1 = __webpack_require__(/*! common/Color */ "../../out/common/Color.js");
exports.DEFAULT_ANSI_COLORS = Object.freeze((() => {
    const colors = [
        Color_1.css.toColor('#2e3436'),
        Color_1.css.toColor('#cc0000'),
        Color_1.css.toColor('#4e9a06'),
        Color_1.css.toColor('#c4a000'),
        Color_1.css.toColor('#3465a4'),
        Color_1.css.toColor('#75507b'),
        Color_1.css.toColor('#06989a'),
        Color_1.css.toColor('#d3d7cf'),
        Color_1.css.toColor('#555753'),
        Color_1.css.toColor('#ef2929'),
        Color_1.css.toColor('#8ae234'),
        Color_1.css.toColor('#fce94f'),
        Color_1.css.toColor('#729fcf'),
        Color_1.css.toColor('#ad7fa8'),
        Color_1.css.toColor('#34e2e2'),
        Color_1.css.toColor('#eeeeec')
    ];
    const v = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    for (let i = 0; i < 216; i++) {
        const r = v[(i / 36) % 6 | 0];
        const g = v[(i / 6) % 6 | 0];
        const b = v[i % 6];
        colors.push({
            css: Color_1.channels.toCss(r, g, b),
            rgba: Color_1.channels.toRgba(r, g, b)
        });
    }
    for (let i = 0; i < 24; i++) {
        const c = 8 + i * 10;
        colors.push({
            css: Color_1.channels.toCss(c, c, c),
            rgba: Color_1.channels.toRgba(c, c, c)
        });
    }
    return colors;
})());


/***/ },

/***/ "../../out/common/Color.js"
/*!*********************************!*\
  !*** ../../out/common/Color.js ***!
  \*********************************/
(__unused_webpack_module, exports) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.rgba = exports.rgb = exports.css = exports.color = exports.channels = exports.NULL_COLOR = void 0;
exports.toPaddedHex = toPaddedHex;
exports.contrastRatio = contrastRatio;
let $r = 0;
let $g = 0;
let $b = 0;
let $a = 0;
exports.NULL_COLOR = {
    css: '#00000000',
    rgba: 0
};
var channels;
(function (channels) {
    function toCss(r, g, b, a) {
        if (a !== undefined) {
            return `#${toPaddedHex(r)}${toPaddedHex(g)}${toPaddedHex(b)}${toPaddedHex(a)}`;
        }
        return `#${toPaddedHex(r)}${toPaddedHex(g)}${toPaddedHex(b)}`;
    }
    channels.toCss = toCss;
    function toRgba(r, g, b, a = 0xFF) {
        return (r << 24 | g << 16 | b << 8 | a) >>> 0;
    }
    channels.toRgba = toRgba;
    function toColor(r, g, b, a) {
        return {
            css: channels.toCss(r, g, b, a),
            rgba: channels.toRgba(r, g, b, a)
        };
    }
    channels.toColor = toColor;
})(channels || (exports.channels = channels = {}));
var color;
(function (color_1) {
    function blend(bg, fg) {
        $a = (fg.rgba & 0xFF) / 255;
        if ($a === 1) {
            return {
                css: fg.css,
                rgba: fg.rgba
            };
        }
        const fgR = (fg.rgba >> 24) & 0xFF;
        const fgG = (fg.rgba >> 16) & 0xFF;
        const fgB = (fg.rgba >> 8) & 0xFF;
        const bgR = (bg.rgba >> 24) & 0xFF;
        const bgG = (bg.rgba >> 16) & 0xFF;
        const bgB = (bg.rgba >> 8) & 0xFF;
        $r = bgR + Math.round((fgR - bgR) * $a);
        $g = bgG + Math.round((fgG - bgG) * $a);
        $b = bgB + Math.round((fgB - bgB) * $a);
        const css = channels.toCss($r, $g, $b);
        const rgba = channels.toRgba($r, $g, $b);
        return { css, rgba };
    }
    color_1.blend = blend;
    function isOpaque(color) {
        return (color.rgba & 0xFF) === 0xFF;
    }
    color_1.isOpaque = isOpaque;
    function ensureContrastRatio(bg, fg, ratio) {
        const result = rgba.ensureContrastRatio(bg.rgba, fg.rgba, ratio);
        if (!result) {
            return undefined;
        }
        return channels.toColor((result >> 24 & 0xFF), (result >> 16 & 0xFF), (result >> 8 & 0xFF));
    }
    color_1.ensureContrastRatio = ensureContrastRatio;
    function opaque(color) {
        const rgbaColor = (color.rgba | 0xFF) >>> 0;
        [$r, $g, $b] = rgba.toChannels(rgbaColor);
        return {
            css: channels.toCss($r, $g, $b),
            rgba: rgbaColor
        };
    }
    color_1.opaque = opaque;
    function opacity(color, opacity) {
        $a = Math.round(opacity * 0xFF);
        [$r, $g, $b] = rgba.toChannels(color.rgba);
        return {
            css: channels.toCss($r, $g, $b, $a),
            rgba: channels.toRgba($r, $g, $b, $a)
        };
    }
    color_1.opacity = opacity;
    function multiplyOpacity(color, factor) {
        $a = color.rgba & 0xFF;
        return opacity(color, ($a * factor) / 0xFF);
    }
    color_1.multiplyOpacity = multiplyOpacity;
    function toColorRGB(color) {
        return [(color.rgba >> 24) & 0xFF, (color.rgba >> 16) & 0xFF, (color.rgba >> 8) & 0xFF];
    }
    color_1.toColorRGB = toColorRGB;
})(color || (exports.color = color = {}));
var css;
(function (css_1) {
    let $ctx;
    let $litmusColor;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', {
            willReadFrequently: true
        });
        if (ctx) {
            $ctx = ctx;
            $ctx.globalCompositeOperation = 'copy';
            $litmusColor = $ctx.createLinearGradient(0, 0, 1, 1);
        }
    }
    catch {
    }
    function toColor(css) {
        if (css.match(/#[\da-f]{3,8}/i)) {
            switch (css.length) {
                case 4: {
                    $r = parseInt(css.slice(1, 2).repeat(2), 16);
                    $g = parseInt(css.slice(2, 3).repeat(2), 16);
                    $b = parseInt(css.slice(3, 4).repeat(2), 16);
                    return channels.toColor($r, $g, $b);
                }
                case 5: {
                    $r = parseInt(css.slice(1, 2).repeat(2), 16);
                    $g = parseInt(css.slice(2, 3).repeat(2), 16);
                    $b = parseInt(css.slice(3, 4).repeat(2), 16);
                    $a = parseInt(css.slice(4, 5).repeat(2), 16);
                    return channels.toColor($r, $g, $b, $a);
                }
                case 7:
                    return {
                        css,
                        rgba: (parseInt(css.slice(1), 16) << 8 | 0xFF) >>> 0
                    };
                case 9:
                    return {
                        css,
                        rgba: parseInt(css.slice(1), 16) >>> 0
                    };
            }
        }
        const rgbaMatch = css.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/);
        if (rgbaMatch) {
            $r = parseInt(rgbaMatch[1]);
            $g = parseInt(rgbaMatch[2]);
            $b = parseInt(rgbaMatch[3]);
            $a = Math.round((rgbaMatch[5] === undefined ? 1 : parseFloat(rgbaMatch[5])) * 0xFF);
            return channels.toColor($r, $g, $b, $a);
        }
        if (!$ctx || !$litmusColor) {
            throw new Error('css.toColor: Unsupported css format');
        }
        $ctx.fillStyle = $litmusColor;
        $ctx.fillStyle = css;
        if (typeof $ctx.fillStyle !== 'string') {
            throw new Error('css.toColor: Unsupported css format');
        }
        $ctx.fillRect(0, 0, 1, 1);
        [$r, $g, $b, $a] = $ctx.getImageData(0, 0, 1, 1).data;
        if ($a !== 0xFF) {
            throw new Error('css.toColor: Unsupported css format');
        }
        return {
            rgba: channels.toRgba($r, $g, $b, $a),
            css
        };
    }
    css_1.toColor = toColor;
})(css || (exports.css = css = {}));
var rgb;
(function (rgb_1) {
    function relativeLuminance(rgb) {
        return relativeLuminance2((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, (rgb) & 0xFF);
    }
    rgb_1.relativeLuminance = relativeLuminance;
    function relativeLuminance2(r, g, b) {
        const rs = r / 255;
        const gs = g / 255;
        const bs = b / 255;
        const rr = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
        const rg = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
        const rb = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);
        return rr * 0.2126 + rg * 0.7152 + rb * 0.0722;
    }
    rgb_1.relativeLuminance2 = relativeLuminance2;
})(rgb || (exports.rgb = rgb = {}));
var rgba;
(function (rgba) {
    function blend(bg, fg) {
        $a = (fg & 0xFF) / 0xFF;
        if ($a === 1) {
            return fg;
        }
        const fgR = (fg >> 24) & 0xFF;
        const fgG = (fg >> 16) & 0xFF;
        const fgB = (fg >> 8) & 0xFF;
        const bgR = (bg >> 24) & 0xFF;
        const bgG = (bg >> 16) & 0xFF;
        const bgB = (bg >> 8) & 0xFF;
        $r = bgR + Math.round((fgR - bgR) * $a);
        $g = bgG + Math.round((fgG - bgG) * $a);
        $b = bgB + Math.round((fgB - bgB) * $a);
        return channels.toRgba($r, $g, $b);
    }
    rgba.blend = blend;
    function ensureContrastRatio(bgRgba, fgRgba, ratio) {
        const bgL = rgb.relativeLuminance(bgRgba >> 8);
        const fgL = rgb.relativeLuminance(fgRgba >> 8);
        const cr = contrastRatio(bgL, fgL);
        if (cr < ratio) {
            if (fgL < bgL) {
                const resultA = reduceLuminance(bgRgba, fgRgba, ratio);
                const resultARatio = contrastRatio(bgL, rgb.relativeLuminance(resultA >> 8));
                if (resultARatio < ratio) {
                    const resultB = increaseLuminance(bgRgba, fgRgba, ratio);
                    const resultBRatio = contrastRatio(bgL, rgb.relativeLuminance(resultB >> 8));
                    return resultARatio > resultBRatio ? resultA : resultB;
                }
                return resultA;
            }
            const resultA = increaseLuminance(bgRgba, fgRgba, ratio);
            const resultARatio = contrastRatio(bgL, rgb.relativeLuminance(resultA >> 8));
            if (resultARatio < ratio) {
                const resultB = reduceLuminance(bgRgba, fgRgba, ratio);
                const resultBRatio = contrastRatio(bgL, rgb.relativeLuminance(resultB >> 8));
                return resultARatio > resultBRatio ? resultA : resultB;
            }
            return resultA;
        }
        return undefined;
    }
    rgba.ensureContrastRatio = ensureContrastRatio;
    function reduceLuminance(bgRgba, fgRgba, ratio) {
        const bgR = (bgRgba >> 24) & 0xFF;
        const bgG = (bgRgba >> 16) & 0xFF;
        const bgB = (bgRgba >> 8) & 0xFF;
        let fgR = (fgRgba >> 24) & 0xFF;
        let fgG = (fgRgba >> 16) & 0xFF;
        let fgB = (fgRgba >> 8) & 0xFF;
        let cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
        while (cr < ratio && (fgR > 0 || fgG > 0 || fgB > 0)) {
            fgR -= Math.max(0, Math.ceil(fgR * 0.1));
            fgG -= Math.max(0, Math.ceil(fgG * 0.1));
            fgB -= Math.max(0, Math.ceil(fgB * 0.1));
            cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
        }
        return (fgR << 24 | fgG << 16 | fgB << 8 | 0xFF) >>> 0;
    }
    rgba.reduceLuminance = reduceLuminance;
    function increaseLuminance(bgRgba, fgRgba, ratio) {
        const bgR = (bgRgba >> 24) & 0xFF;
        const bgG = (bgRgba >> 16) & 0xFF;
        const bgB = (bgRgba >> 8) & 0xFF;
        let fgR = (fgRgba >> 24) & 0xFF;
        let fgG = (fgRgba >> 16) & 0xFF;
        let fgB = (fgRgba >> 8) & 0xFF;
        let cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
        while (cr < ratio && (fgR < 0xFF || fgG < 0xFF || fgB < 0xFF)) {
            fgR = Math.min(0xFF, fgR + Math.ceil((255 - fgR) * 0.1));
            fgG = Math.min(0xFF, fgG + Math.ceil((255 - fgG) * 0.1));
            fgB = Math.min(0xFF, fgB + Math.ceil((255 - fgB) * 0.1));
            cr = contrastRatio(rgb.relativeLuminance2(fgR, fgG, fgB), rgb.relativeLuminance2(bgR, bgG, bgB));
        }
        return (fgR << 24 | fgG << 16 | fgB << 8 | 0xFF) >>> 0;
    }
    rgba.increaseLuminance = increaseLuminance;
    function toChannels(value) {
        return [(value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
    }
    rgba.toChannels = toChannels;
})(rgba || (exports.rgba = rgba = {}));
function toPaddedHex(c) {
    const s = c.toString(16);
    return s.length < 2 ? '0' + s : s;
}
function contrastRatio(l1, l2) {
    if (l1 < l2) {
        return (l2 + 0.05) / (l1 + 0.05);
    }
    return (l1 + 0.05) / (l2 + 0.05);
}


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
var exports = __webpack_exports__;
/*!*******************************!*\
  !*** ./out/SerializeAddon.js ***!
  \*******************************/

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.HTMLSerializeHandler = exports.SerializeAddon = void 0;
const Types_1 = __webpack_require__(/*! browser/Types */ "../../out/browser/Types.js");
function constrain(value, low, high) {
    return Math.max(low, Math.min(value, high));
}
function escapeHTMLChar(c) {
    switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
    }
    return c;
}
class BaseSerializeHandler {
    constructor(_buffer) {
        this._buffer = _buffer;
    }
    serialize(range, excludeFinalCursorPosition) {
        const cell1 = this._buffer.getNullCell();
        const cell2 = this._buffer.getNullCell();
        let oldCell = cell1;
        const startRow = range.start.y;
        const endRow = range.end.y;
        const startColumn = range.start.x;
        const endColumn = range.end.x;
        this._beforeSerialize(endRow - startRow, startRow, endRow);
        for (let row = startRow; row <= endRow; row++) {
            const line = this._buffer.getLine(row);
            if (line) {
                const startLineColumn = row === range.start.y ? startColumn : 0;
                const endLineColumn = row === range.end.y ? endColumn : line.length;
                for (let col = startLineColumn; col < endLineColumn; col++) {
                    const c = line.getCell(col, oldCell === cell1 ? cell2 : cell1);
                    if (!c) {
                        console.warn(`Can't get cell at row=${row}, col=${col}`);
                        continue;
                    }
                    this._nextCell(c, oldCell, row, col);
                    oldCell = c;
                }
            }
            this._rowEnd(row, row === endRow);
        }
        this._afterSerialize();
        return this._serializeString(excludeFinalCursorPosition);
    }
    _nextCell(cell, oldCell, row, col) { }
    _rowEnd(row, isLastRow) { }
    _beforeSerialize(rows, startRow, endRow) { }
    _afterSerialize() { }
    _serializeString(excludeFinalCursorPosition) { return ''; }
}
function equalFg(cell1, cell2) {
    return cell1.getFgColorMode() === cell2.getFgColorMode()
        && cell1.getFgColor() === cell2.getFgColor();
}
function equalBg(cell1, cell2) {
    return cell1.getBgColorMode() === cell2.getBgColorMode()
        && cell1.getBgColor() === cell2.getBgColor();
}
function equalFlags(cell1, cell2) {
    return cell1.isInverse() === cell2.isInverse()
        && cell1.isBold() === cell2.isBold()
        && cell1.isUnderline() === cell2.isUnderline()
        && cell1.isOverline() === cell2.isOverline()
        && cell1.isBlink() === cell2.isBlink()
        && cell1.isInvisible() === cell2.isInvisible()
        && cell1.isItalic() === cell2.isItalic()
        && cell1.isDim() === cell2.isDim()
        && cell1.isStrikethrough() === cell2.isStrikethrough();
}
class StringSerializeHandler extends BaseSerializeHandler {
    constructor(buffer, _terminal) {
        super(buffer);
        this._terminal = _terminal;
        this._rowIndex = 0;
        this._allRows = new Array();
        this._allRowSeparators = new Array();
        this._currentRow = '';
        this._nullCellCount = 0;
        this._cursorStyle = this._buffer.getNullCell();
        this._cursorStyleRow = 0;
        this._cursorStyleCol = 0;
        this._backgroundCell = this._buffer.getNullCell();
        this._firstRow = 0;
        this._lastCursorRow = 0;
        this._lastCursorCol = 0;
        this._lastContentCursorRow = 0;
        this._lastContentCursorCol = 0;
        this._thisRowLastChar = this._buffer.getNullCell();
        this._thisRowLastSecondChar = this._buffer.getNullCell();
        this._nextRowFirstChar = this._buffer.getNullCell();
    }
    _beforeSerialize(rows, start, end) {
        this._allRows = new Array(rows);
        this._lastContentCursorRow = start;
        this._lastCursorRow = start;
        this._firstRow = start;
    }
    _rowEnd(row, isLastRow) {
        if (this._nullCellCount > 0 && !equalBg(this._cursorStyle, this._backgroundCell)) {
            this._currentRow += `\u001b[${this._nullCellCount}X`;
        }
        let rowSeparator = '';
        if (!isLastRow) {
            if (row - this._firstRow >= this._terminal.rows) {
                this._buffer.getLine(this._cursorStyleRow)?.getCell(this._cursorStyleCol, this._backgroundCell);
            }
            const currentLine = this._buffer.getLine(row);
            const nextLine = this._buffer.getLine(row + 1);
            if (!nextLine.isWrapped) {
                rowSeparator = '\r\n';
                this._lastCursorRow = row + 1;
                this._lastCursorCol = 0;
            }
            else {
                rowSeparator = '';
                const thisRowLastChar = currentLine.getCell(currentLine.length - 1, this._thisRowLastChar);
                const thisRowLastSecondChar = currentLine.getCell(currentLine.length - 2, this._thisRowLastSecondChar);
                const nextRowFirstChar = nextLine.getCell(0, this._nextRowFirstChar);
                const isNextRowFirstCharDoubleWidth = nextRowFirstChar.getWidth() > 1;
                let isValid = false;
                if (nextRowFirstChar.getChars() &&
                    isNextRowFirstCharDoubleWidth ? this._nullCellCount <= 1 : this._nullCellCount <= 0) {
                    if ((thisRowLastChar.getChars() || thisRowLastChar.getWidth() === 0) &&
                        equalBg(thisRowLastChar, nextRowFirstChar)) {
                        isValid = true;
                    }
                    if (isNextRowFirstCharDoubleWidth &&
                        (thisRowLastSecondChar.getChars() || thisRowLastSecondChar.getWidth() === 0) &&
                        equalBg(thisRowLastChar, nextRowFirstChar) &&
                        equalBg(thisRowLastSecondChar, nextRowFirstChar)) {
                        isValid = true;
                    }
                }
                if (!isValid) {
                    rowSeparator = '-'.repeat(this._nullCellCount + 1);
                    rowSeparator += '\u001b[1D\u001b[1X';
                    if (this._nullCellCount > 0) {
                        rowSeparator += '\u001b[A';
                        rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}C`;
                        rowSeparator += `\u001b[${this._nullCellCount}X`;
                        rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}D`;
                        rowSeparator += '\u001b[B';
                    }
                    this._lastContentCursorRow = row + 1;
                    this._lastContentCursorCol = 0;
                    this._lastCursorRow = row + 1;
                    this._lastCursorCol = 0;
                }
            }
        }
        this._allRows[this._rowIndex] = this._currentRow;
        this._allRowSeparators[this._rowIndex++] = rowSeparator;
        this._currentRow = '';
        this._nullCellCount = 0;
    }
    _diffStyle(cell, oldCell) {
        const sgrSeq = [];
        const fgChanged = !equalFg(cell, oldCell);
        const bgChanged = !equalBg(cell, oldCell);
        const flagsChanged = !equalFlags(cell, oldCell);
        if (fgChanged || bgChanged || flagsChanged) {
            if (cell.isAttributeDefault()) {
                if (!oldCell.isAttributeDefault()) {
                    sgrSeq.push(0);
                }
            }
            else {
                if (fgChanged) {
                    const color = cell.getFgColor();
                    if (cell.isFgRGB()) {
                        sgrSeq.push(38, 2, (color >>> 16) & 0xFF, (color >>> 8) & 0xFF, color & 0xFF);
                    }
                    else if (cell.isFgPalette()) {
                        if (color >= 16) {
                            sgrSeq.push(38, 5, color);
                        }
                        else {
                            sgrSeq.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7));
                        }
                    }
                    else {
                        sgrSeq.push(39);
                    }
                }
                if (bgChanged) {
                    const color = cell.getBgColor();
                    if (cell.isBgRGB()) {
                        sgrSeq.push(48, 2, (color >>> 16) & 0xFF, (color >>> 8) & 0xFF, color & 0xFF);
                    }
                    else if (cell.isBgPalette()) {
                        if (color >= 16) {
                            sgrSeq.push(48, 5, color);
                        }
                        else {
                            sgrSeq.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7));
                        }
                    }
                    else {
                        sgrSeq.push(49);
                    }
                }
                if (flagsChanged) {
                    if (cell.isInverse() !== oldCell.isInverse()) {
                        sgrSeq.push(cell.isInverse() ? 7 : 27);
                    }
                    if (cell.isBold() !== oldCell.isBold()) {
                        sgrSeq.push(cell.isBold() ? 1 : 22);
                    }
                    if (cell.isUnderline() !== oldCell.isUnderline()) {
                        sgrSeq.push(cell.isUnderline() ? 4 : 24);
                    }
                    if (cell.isOverline() !== oldCell.isOverline()) {
                        sgrSeq.push(cell.isOverline() ? 53 : 55);
                    }
                    if (cell.isBlink() !== oldCell.isBlink()) {
                        sgrSeq.push(cell.isBlink() ? 5 : 25);
                    }
                    if (cell.isInvisible() !== oldCell.isInvisible()) {
                        sgrSeq.push(cell.isInvisible() ? 8 : 28);
                    }
                    if (cell.isItalic() !== oldCell.isItalic()) {
                        sgrSeq.push(cell.isItalic() ? 3 : 23);
                    }
                    if (cell.isDim() !== oldCell.isDim()) {
                        sgrSeq.push(cell.isDim() ? 2 : 22);
                    }
                    if (cell.isStrikethrough() !== oldCell.isStrikethrough()) {
                        sgrSeq.push(cell.isStrikethrough() ? 9 : 29);
                    }
                }
            }
        }
        return sgrSeq;
    }
    _nextCell(cell, oldCell, row, col) {
        const isPlaceHolderCell = cell.getWidth() === 0;
        if (isPlaceHolderCell) {
            return;
        }
        const isEmptyCell = cell.getChars() === '';
        const sgrSeq = this._diffStyle(cell, this._cursorStyle);
        const styleChanged = isEmptyCell ? !equalBg(this._cursorStyle, cell) : sgrSeq.length > 0;
        if (styleChanged) {
            if (this._nullCellCount > 0) {
                if (!equalBg(this._cursorStyle, this._backgroundCell)) {
                    this._currentRow += `\u001b[${this._nullCellCount}X`;
                }
                this._currentRow += `\u001b[${this._nullCellCount}C`;
                this._nullCellCount = 0;
            }
            this._lastContentCursorRow = this._lastCursorRow = row;
            this._lastContentCursorCol = this._lastCursorCol = col;
            this._currentRow += `\u001b[${sgrSeq.join(';')}m`;
            const line = this._buffer.getLine(row);
            if (line !== undefined) {
                line.getCell(col, this._cursorStyle);
                this._cursorStyleRow = row;
                this._cursorStyleCol = col;
            }
        }
        if (isEmptyCell) {
            this._nullCellCount += cell.getWidth();
        }
        else {
            if (this._nullCellCount > 0) {
                if (equalBg(this._cursorStyle, this._backgroundCell)) {
                    this._currentRow += `\u001b[${this._nullCellCount}C`;
                }
                else {
                    this._currentRow += `\u001b[${this._nullCellCount}X`;
                    this._currentRow += `\u001b[${this._nullCellCount}C`;
                }
                this._nullCellCount = 0;
            }
            this._currentRow += cell.getChars();
            this._lastContentCursorRow = this._lastCursorRow = row;
            this._lastContentCursorCol = this._lastCursorCol = col + cell.getWidth();
        }
    }
    _serializeString(excludeFinalCursorPosition) {
        let rowEnd = this._allRows.length;
        if (this._buffer.length - this._firstRow <= this._terminal.rows) {
            rowEnd = this._lastContentCursorRow + 1 - this._firstRow;
            this._lastCursorCol = this._lastContentCursorCol;
            this._lastCursorRow = this._lastContentCursorRow;
        }
        let content = '';
        for (let i = 0; i < rowEnd; i++) {
            content += this._allRows[i];
            if (i + 1 < rowEnd) {
                content += this._allRowSeparators[i];
            }
        }
        if (!excludeFinalCursorPosition) {
            const realCursorRow = this._buffer.baseY + this._buffer.cursorY;
            const realCursorCol = this._buffer.cursorX;
            const cursorMoved = (realCursorRow !== this._lastCursorRow || realCursorCol !== this._lastCursorCol);
            const moveRight = (offset) => {
                if (offset > 0) {
                    content += `\u001b[${offset}C`;
                }
                else if (offset < 0) {
                    content += `\u001b[${-offset}D`;
                }
            };
            const moveDown = (offset) => {
                if (offset > 0) {
                    content += `\u001b[${offset}B`;
                }
                else if (offset < 0) {
                    content += `\u001b[${-offset}A`;
                }
            };
            if (cursorMoved) {
                moveDown(realCursorRow - this._lastCursorRow);
                moveRight(realCursorCol - this._lastCursorCol);
            }
        }
        const curAttrData = this._terminal._core._inputHandler._curAttrData;
        const sgrSeq = this._diffStyle(curAttrData, this._cursorStyle);
        if (sgrSeq.length > 0) {
            content += `\u001b[${sgrSeq.join(';')}m`;
        }
        return content;
    }
}
class SerializeAddon {
    activate(terminal) {
        this._terminal = terminal;
    }
    _serializeBufferByScrollback(terminal, buffer, scrollback) {
        const maxRows = buffer.length;
        const correctRows = (scrollback === undefined) ? maxRows : constrain(scrollback + terminal.rows, 0, maxRows);
        return this._serializeBufferByRange(terminal, buffer, {
            start: maxRows - correctRows,
            end: maxRows - 1
        }, false);
    }
    _serializeBufferByRange(terminal, buffer, range, excludeFinalCursorPosition) {
        const handler = new StringSerializeHandler(buffer, terminal);
        return handler.serialize({
            start: { x: 0, y: typeof range.start === 'number' ? range.start : range.start.line },
            end: { x: terminal.cols, y: typeof range.end === 'number' ? range.end : range.end.line }
        }, excludeFinalCursorPosition);
    }
    _serializeBufferAsHTML(terminal, options) {
        const buffer = terminal.buffer.active;
        const handler = new HTMLSerializeHandler(buffer, terminal, options);
        const onlySelection = options.onlySelection ?? false;
        const range = options.range;
        if (range) {
            return handler.serialize({
                start: { x: range.startCol, y: typeof range.startLine === 'number' ? range.startLine : range.startLine },
                end: { x: terminal.cols, y: typeof range.endLine === 'number' ? range.endLine : range.endLine }
            });
        }
        if (!onlySelection) {
            const maxRows = buffer.length;
            const scrollback = options.scrollback;
            const correctRows = (scrollback === undefined) ? maxRows : constrain(scrollback + terminal.rows, 0, maxRows);
            return handler.serialize({
                start: { x: 0, y: maxRows - correctRows },
                end: { x: terminal.cols, y: maxRows - 1 }
            });
        }
        const selection = this._terminal?.getSelectionPosition();
        if (selection !== undefined) {
            return handler.serialize({
                start: { x: selection.start.x, y: selection.start.y },
                end: { x: selection.end.x, y: selection.end.y }
            });
        }
        return '';
    }
    _serializeModes(terminal) {
        let content = '';
        const modes = terminal.modes;
        if (modes.applicationCursorKeysMode)
            content += '\x1b[?1h';
        if (modes.applicationKeypadMode)
            content += '\x1b[?66h';
        if (modes.bracketedPasteMode)
            content += '\x1b[?2004h';
        if (modes.insertMode)
            content += '\x1b[4h';
        if (modes.originMode)
            content += '\x1b[?6h';
        if (modes.reverseWraparoundMode)
            content += '\x1b[?45h';
        if (modes.sendFocusMode)
            content += '\x1b[?1004h';
        if (modes.wraparoundMode === false)
            content += '\x1b[?7l';
        if (modes.mouseTrackingMode !== 'none') {
            switch (modes.mouseTrackingMode) {
                case 'x10':
                    content += '\x1b[?9h';
                    break;
                case 'vt200':
                    content += '\x1b[?1000h';
                    break;
                case 'drag':
                    content += '\x1b[?1002h';
                    break;
                case 'any':
                    content += '\x1b[?1003h';
                    break;
            }
        }
        return content;
    }
    serialize(options) {
        if (!this._terminal) {
            throw new Error('Cannot use addon until it has been loaded');
        }
        let content = options?.range
            ? this._serializeBufferByRange(this._terminal, this._terminal.buffer.normal, options.range, true)
            : this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.normal, options?.scrollback);
        if (!options?.excludeAltBuffer) {
            if (this._terminal.buffer.active.type === 'alternate') {
                const alternativeScreenContent = this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.alternate, undefined);
                content += `\u001b[?1049h\u001b[H${alternativeScreenContent}`;
            }
        }
        if (!options?.excludeModes) {
            content += this._serializeModes(this._terminal);
        }
        return content;
    }
    serializeAsHTML(options) {
        if (!this._terminal) {
            throw new Error('Cannot use addon until it has been loaded');
        }
        return this._serializeBufferAsHTML(this._terminal, options || {});
    }
    dispose() { }
}
exports.SerializeAddon = SerializeAddon;
class HTMLSerializeHandler extends BaseSerializeHandler {
    constructor(buffer, _terminal, _options) {
        super(buffer);
        this._terminal = _terminal;
        this._options = _options;
        this._currentRow = '';
        this._htmlContent = '';
        if (_terminal._core._themeService) {
            this._ansiColors = _terminal._core._themeService.colors.ansi;
            this._themeFg = _terminal._core._themeService.colors.foreground.css;
            this._themeBg = _terminal._core._themeService.colors.background.css;
        }
        else {
            this._ansiColors = Types_1.DEFAULT_ANSI_COLORS;
            this._themeFg = '#ffffff';
            this._themeBg = '#000000';
        }
    }
    _padStart(target, targetLength, padString) {
        targetLength = targetLength >> 0;
        padString = padString ?? ' ';
        if (target.length > targetLength) {
            return target;
        }
        targetLength -= target.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length);
        }
        return padString.slice(0, targetLength) + target;
    }
    _beforeSerialize(rows, start, end) {
        this._htmlContent += '<html><body><!--StartFragment--><pre>';
        let foreground = '#000000';
        let background = '#ffffff';
        if (this._options.includeGlobalBackground ?? false) {
            foreground = this._terminal.options.theme?.foreground ?? '#ffffff';
            background = this._terminal.options.theme?.background ?? '#000000';
        }
        const globalStyleDefinitions = [];
        globalStyleDefinitions.push('color: ' + foreground + ';');
        globalStyleDefinitions.push('background-color: ' + background + ';');
        globalStyleDefinitions.push('font-family: ' + this._terminal.options.fontFamily + ';');
        globalStyleDefinitions.push('font-size: ' + this._terminal.options.fontSize + 'px;');
        this._htmlContent += '<div style=\'' + globalStyleDefinitions.join(' ') + '\'>';
    }
    _afterSerialize() {
        this._htmlContent += '</div>';
        this._htmlContent += '</pre><!--EndFragment--></body></html>';
    }
    _rowEnd(row, isLastRow) {
        this._htmlContent += '<div><span>' + this._currentRow + '</span></div>';
        this._currentRow = '';
    }
    _getHexColor(cell, isFg) {
        const color = isFg ? cell.getFgColor() : cell.getBgColor();
        if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
            const rgb = [
                (color >> 16) & 255,
                (color >> 8) & 255,
                (color) & 255
            ];
            return '#' + rgb.map(x => this._padStart(x.toString(16), 2, '0')).join('');
        }
        if (isFg ? cell.isFgPalette() : cell.isBgPalette()) {
            return this._ansiColors[color].css;
        }
        return undefined;
    }
    _diffStyle(cell, oldCell) {
        const content = [];
        const fgChanged = !equalFg(cell, oldCell);
        const bgChanged = !equalBg(cell, oldCell);
        const flagsChanged = !equalFlags(cell, oldCell);
        if (fgChanged || bgChanged || flagsChanged) {
            const fgHexColor = this._getHexColor(cell, true);
            if (fgHexColor) {
                content.push('color: ' + fgHexColor + ';');
            }
            const bgHexColor = this._getHexColor(cell, false);
            if (bgHexColor) {
                content.push('background-color: ' + bgHexColor + ';');
            }
            if (cell.isInverse()) {
                const inverseFg = bgHexColor || this._themeBg;
                const inverseBg = fgHexColor || this._themeFg;
                content.push('color: ' + inverseFg + '; background-color: ' + inverseBg + ';');
            }
            if (cell.isBold()) {
                content.push('font-weight: bold;');
            }
            if (cell.isUnderline() && cell.isOverline()) {
                content.push('text-decoration: overline underline;');
            }
            else if (cell.isUnderline()) {
                content.push('text-decoration: underline;');
            }
            else if (cell.isOverline()) {
                content.push('text-decoration: overline;');
            }
            if (cell.isBlink()) {
                content.push('text-decoration: blink;');
            }
            if (cell.isInvisible()) {
                content.push('visibility: hidden;');
            }
            if (cell.isItalic()) {
                content.push('font-style: italic;');
            }
            if (cell.isDim()) {
                content.push('opacity: 0.5;');
            }
            if (cell.isStrikethrough()) {
                content.push('text-decoration: line-through;');
            }
            return content;
        }
        return undefined;
    }
    _nextCell(cell, oldCell, row, col) {
        const isPlaceHolderCell = cell.getWidth() === 0;
        if (isPlaceHolderCell) {
            return;
        }
        const isEmptyCell = cell.getChars() === '';
        const styleDefinitions = this._diffStyle(cell, oldCell);
        if (styleDefinitions) {
            this._currentRow += styleDefinitions.length === 0 ?
                '</span><span>' :
                '</span><span style=\'' + styleDefinitions.join(' ') + '\'>';
        }
        if (isEmptyCell) {
            this._currentRow += ' ';
        }
        else {
            this._currentRow += escapeHTMLChar(cell.getChars());
        }
    }
    _serializeString() {
        return this._htmlContent;
    }
}
exports.HTMLSerializeHandler = HTMLSerializeHandler;

})();

/******/ 	return __webpack_exports__;
/******/ })()
;
});
//# sourceMappingURL=addon-serialize.js.map