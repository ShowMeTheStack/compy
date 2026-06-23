import type { Interp, Val } from '@compy/vm';

/**
 * printf-family conversion. Takes the already-evaluated variadic argument
 * values (default-promoted: float→double, small ints→int) and the format
 * string, and produces the formatted output text. Supports flags (- + space #
 * 0), width, precision, length modifiers (h/hh/l/ll/L/z), and the conversions
 * d i u o x X c s f F e E g G p %.
 */
export function formatPrintf(ctx: Interp, fmt: string, args: Val[], startIdx: number): string {
  let out = '';
  let ai = startIdx;
  const nextArg = (): Val | undefined => args[ai++];

  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i]!;
    if (c !== '%') {
      out += c;
      i++;
      continue;
    }
    i++;
    if (fmt[i] === '%') {
      out += '%';
      i++;
      continue;
    }
    // flags
    let flagMinus = false, flagPlus = false, flagSpace = false, flagHash = false, flagZero = false;
    for (; i < fmt.length; i++) {
      const f = fmt[i];
      if (f === '-') flagMinus = true;
      else if (f === '+') flagPlus = true;
      else if (f === ' ') flagSpace = true;
      else if (f === '#') flagHash = true;
      else if (f === '0') flagZero = true;
      else break;
    }
    // width
    let width = 0;
    if (fmt[i] === '*') {
      width = Number(bigOf(nextArg()));
      i++;
      if (width < 0) {
        flagMinus = true;
        width = -width;
      }
    } else {
      while (isDigit(fmt[i])) width = width * 10 + (fmt[i]!.charCodeAt(0) - 48), i++;
    }
    // precision
    let precision = -1;
    if (fmt[i] === '.') {
      i++;
      precision = 0;
      if (fmt[i] === '*') {
        precision = Number(bigOf(nextArg()));
        i++;
      } else {
        while (isDigit(fmt[i])) precision = precision * 10 + (fmt[i]!.charCodeAt(0) - 48), i++;
      }
    }
    // length modifiers (consumed; args already promoted)
    while (fmt[i] && 'hljztL'.includes(fmt[i]!)) i++;

    const spec = fmt[i];
    i++;
    switch (spec) {
      case 'd':
      case 'i': {
        const v = signedOf(nextArg());
        out += padNumber(formatInt(v < 0n ? -v : v, 10, false), v < 0n, flagPlus, flagSpace, width, precision, flagMinus, flagZero, '');
        break;
      }
      case 'u':
        out += padNumber(formatInt(unsignedOf(nextArg()), 10, false), false, false, false, width, precision, flagMinus, flagZero, '');
        break;
      case 'o':
        out += padNumber(formatInt(unsignedOf(nextArg()), 8, false), false, false, false, width, precision, flagMinus, flagZero, flagHash ? '0' : '');
        break;
      case 'x':
        out += padNumber(formatInt(unsignedOf(nextArg()), 16, false), false, false, false, width, precision, flagMinus, flagZero, flagHash ? '0x' : '');
        break;
      case 'X':
        out += padNumber(formatInt(unsignedOf(nextArg()), 16, true), false, false, false, width, precision, flagMinus, flagZero, flagHash ? '0X' : '');
        break;
      case 'c':
        out += pad(String.fromCharCode(Number(bigOf(nextArg())) & 0xff), width, flagMinus, false);
        break;
      case 's': {
        let s = ctx.readCString(Number(bigOf(nextArg())));
        if (precision >= 0) s = s.slice(0, precision);
        out += pad(s, width, flagMinus, false);
        break;
      }
      case 'p': {
        const addr = Number(bigOf(nextArg())) >>> 0;
        out += pad(addr === 0 ? '(nil)' : '0x' + addr.toString(16), width, flagMinus, false);
        break;
      }
      case 'f':
      case 'F':
        out += padFloat(formatFixed(floatOf(nextArg()), precision < 0 ? 6 : precision), flagPlus, flagSpace, width, flagMinus, flagZero);
        break;
      case 'e':
      case 'E':
        out += padFloat(formatExp(floatOf(nextArg()), precision < 0 ? 6 : precision, spec === 'E'), flagPlus, flagSpace, width, flagMinus, flagZero);
        break;
      case 'g':
      case 'G':
        out += padFloat(formatG(floatOf(nextArg()), precision < 0 ? 6 : precision, spec === 'G'), flagPlus, flagSpace, width, flagMinus, flagZero);
        break;
      default:
        out += '%' + (spec ?? '');
    }
  }
  return out;
}

function isDigit(c: string | undefined): boolean {
  return !!c && c >= '0' && c <= '9';
}
function bigOf(v: Val | undefined): bigint {
  if (!v) return 0n;
  return v.type.kind === 'float' ? BigInt(Math.trunc(v.f)) : v.i;
}
function signedOf(v: Val | undefined): bigint {
  return bigOf(v);
}
function unsignedOf(v: Val | undefined): bigint {
  let x = bigOf(v);
  if (x < 0n) x += 1n << 32n; // treat as 32-bit unsigned by default
  return x;
}
function floatOf(v: Val | undefined): number {
  if (!v) return 0;
  return v.type.kind === 'float' ? v.f : Number(v.i);
}

function formatInt(v: bigint, base: number, upper: boolean): string {
  const s = v.toString(base);
  return upper ? s.toUpperCase() : s;
}

function padNumber(
  digits: string,
  neg: boolean,
  plus: boolean,
  space: boolean,
  width: number,
  precision: number,
  left: boolean,
  zero: boolean,
  prefix: string,
): string {
  if (precision >= 0) {
    zero = false;
    while (digits.length < precision) digits = '0' + digits;
    if (precision === 0 && digits === '0') digits = '';
  }
  let sign = neg ? '-' : plus ? '+' : space ? ' ' : '';
  let body = prefix + digits;
  const total = sign.length + body.length;
  if (total >= width) return sign + body;
  const padLen = width - total;
  if (left) return sign + body + ' '.repeat(padLen);
  if (zero) return sign + prefix + '0'.repeat(padLen) + digits;
  return ' '.repeat(padLen) + sign + body;
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  const p = (zero ? '0' : ' ').repeat(width - s.length);
  return left ? s + p : p + s;
}

function padFloat(s: string, plus: boolean, space: boolean, width: number, left: boolean, zero: boolean): string {
  let neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const sign = neg ? '-' : plus ? '+' : space ? ' ' : '';
  const total = sign.length + s.length;
  if (total >= width) return sign + s;
  const padLen = width - total;
  if (left) return sign + s + ' '.repeat(padLen);
  if (zero) return sign + '0'.repeat(padLen) + s;
  return ' '.repeat(padLen) + sign + s;
}

function formatFixed(x: number, prec: number): string {
  if (!isFinite(x)) return x > 0 ? 'inf' : isNaN(x) ? 'nan' : '-inf';
  return x.toFixed(prec);
}
function formatExp(x: number, prec: number, upper: boolean): string {
  if (!isFinite(x)) return x > 0 ? 'inf' : isNaN(x) ? 'nan' : '-inf';
  let s = x.toExponential(prec);
  // C uses at least two exponent digits.
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}
function formatG(x: number, prec: number, upper: boolean): string {
  if (prec === 0) prec = 1;
  if (!isFinite(x)) return x > 0 ? 'inf' : isNaN(x) ? 'nan' : '-inf';
  const exp = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)));
  let s: string;
  if (exp < -4 || exp >= prec) {
    s = x.toExponential(prec - 1).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2');
  } else {
    s = x.toFixed(Math.max(0, prec - 1 - exp));
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return upper ? s.toUpperCase() : s;
}
