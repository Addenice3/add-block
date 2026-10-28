// A strict validator for the CSS selectors used by cosmetic filters.
//
// One invalid selector makes a browser drop the whole CSS rule it belongs
// to, and the generated stylesheets put many selectors in one rule. So a
// selector is only accepted when it is fully understood: standard CSS
// selector syntax plus a fixed set of pseudo-classes and pseudo-elements that
// Chrome, Edge and Safari all support. Anything else (adblocker extensions
// like :-abp-has, unknown pseudo-classes, odd syntax) is rejected with a
// reason, and the build counts it.
//
// Rejected on purpose, even though CSS allows them inside strings: "{", "}"
// and "/*", so that a stylesheet can be checked rule by rule with simple
// text tools, and "url(", so that nothing in a selector can look like a
// resource reference.

const PSEUDO_CLASSES = new Set([
  "active", "checked", "default", "disabled", "empty", "enabled", "first-child", "first-of-type",
  "focus", "focus-within", "hover", "last-child", "last-of-type", "link", "only-child",
  "only-of-type", "optional", "required", "root", "target", "visited",
]);
const PSEUDO_SELECTOR_LIST = new Set(["not", "is", "where"]);
const PSEUDO_RELATIVE_LIST = new Set(["has"]);
const PSEUDO_NTH = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);
const PSEUDO_ELEMENTS = new Set(["after", "before", "first-letter", "first-line", "marker", "placeholder"]);
const LEGACY_PSEUDO_ELEMENTS = new Set(["after", "before", "first-letter", "first-line"]);
const NTH = /^\s*(odd|even|[+-]?\d*n(\s*[+-]\s*\d+)?|[+-]?\d+)\s*$/i;
const ATTRIBUTE_OPERATORS = ["~=", "|=", "^=", "$=", "*=", "="];
const FORBIDDEN = /[{}]|\/\*|url\(/i;

class SelectorError extends Error {}

class Parser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.inHas = false;
  }

  get rest() {
    return this.text.slice(this.pos);
  }

  fail(message) {
    throw new SelectorError(`${message} at offset ${this.pos}`);
  }

  peek(offset = 0) {
    return this.text[this.pos + offset] ?? "";
  }

  eat(string) {
    if (this.text.startsWith(string, this.pos)) {
      this.pos += string.length;
      return true;
    }
    return false;
  }

  expect(string) {
    if (!this.eat(string)) this.fail(`expected "${string}"`);
  }

  skipWhitespace() {
    const start = this.pos;
    while (/[ \t\n\r\f]/.test(this.peek())) this.pos++;
    return this.pos > start;
  }

  // A CSS escape: backslash + 1-6 hex digits (+ optional space) or any other
  // character except a newline.
  eatEscape() {
    if (this.peek() !== "\\") return false;
    const hex = /^\\([0-9a-f]{1,6})[ \t\n\r\f]?/i.exec(this.rest);
    if (hex) {
      this.pos += hex[0].length;
      return true;
    }
    const next = this.peek(1);
    if (next === "" || next === "\n" || next === "\r" || next === "\f") this.fail("bad escape");
    this.pos += 2;
    return true;
  }

  static isNameStart(char) {
    return /[a-z_]/i.test(char) || char.charCodeAt(0) >= 0x80;
  }

  static isNameChar(char) {
    return /[a-z0-9_-]/i.test(char) || char.charCodeAt(0) >= 0x80;
  }

  eatIdentifier() {
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    const first = this.peek();
    if (first === "-" ) this.pos++;
    else if (Parser.isNameStart(first)) this.pos++;
    else if (!this.eatEscape()) {
      this.pos = start;
      return null;
    }
    while (this.peek() !== "") {
      if (Parser.isNameChar(this.peek())) this.pos++;
      else if (!this.eatEscape()) break;
    }
    return this.text.slice(start, this.pos);
  }

  expectIdentifier(what) {
    const identifier = this.eatIdentifier();
    if (identifier === null) this.fail(`expected ${what}`);
    return identifier;
  }

  eatString() {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") return false;
    this.pos++;
    for (;;) {
      const char = this.peek();
      if (char === "") this.fail("unterminated string");
      if (char === "\n" || char === "\r" || char === "\f") this.fail("newline in string");
      if (char === quote) {
        this.pos++;
        return true;
      }
      if (char === "\\") {
        // A backslash before a newline inside a string is allowed by CSS but
        // is too exotic for a filter list.
        this.eatEscape();
        continue;
      }
      this.pos++;
    }
  }

  parseSelectorList(relative = false) {
    for (;;) {
      this.skipWhitespace();
      this.parseComplexSelector(relative);
      this.skipWhitespace();
      if (!this.eat(",")) return;
    }
  }

  eatCombinator() {
    const hadWhitespace = this.skipWhitespace();
    for (const combinator of [">", "+", "~"]) {
      if (this.eat(combinator)) {
        this.skipWhitespace();
        return combinator;
      }
    }
    return hadWhitespace ? " " : null;
  }

  parseComplexSelector(relative) {
    // A relative selector (inside :has()) may start with a combinator; a
    // missing one means descendant.
    if (relative) this.eatCombinator();
    this.parseCompoundSelector();
    for (;;) {
      const save = this.pos;
      const combinator = this.eatCombinator();
      if (combinator === null || !this.startsCompound()) {
        this.pos = save;
        return;
      }
      this.parseCompoundSelector();
    }
  }

  startsCompound() {
    const char = this.peek();
    return char === "*" || char === "#" || char === "." || char === "[" || char === ":" || Parser.isNameStart(char) || char === "-" || char === "\\";
  }

  parseCompoundSelector() {
    let parts = 0;
    if (this.eat("*")) parts++;
    else if (this.eatIdentifier() !== null) parts++;
    for (;;) {
      if (this.eat("#")) {
        // An id must be an identifier, not a hash token like #123.
        this.expectIdentifier("id");
      } else if (this.eat(".")) {
        this.expectIdentifier("class name");
      } else if (this.eat("[")) {
        this.parseAttribute();
      } else if (this.eat("::")) {
        const name = this.expectIdentifier("pseudo-element").toLowerCase();
        if (!PSEUDO_ELEMENTS.has(name) || this.inHas) this.fail(`unsupported pseudo-element ::${name}`);
      } else if (this.eat(":")) {
        this.parsePseudoClass();
      } else {
        break;
      }
      parts++;
    }
    if (parts === 0) this.fail("expected a selector");
  }

  parseAttribute() {
    this.skipWhitespace();
    this.expectIdentifier("attribute name");
    this.skipWhitespace();
    if (this.eat("]")) return;
    const operator = ATTRIBUTE_OPERATORS.find((op) => this.eat(op));
    if (!operator) this.fail("expected attribute operator");
    this.skipWhitespace();
    if (!this.eatString() && this.eatIdentifier() === null) this.fail("expected attribute value");
    this.skipWhitespace();
    if (/[is]/i.test(this.peek()) && /[\s\]]/.test(this.peek(1))) {
      this.pos++;
      this.skipWhitespace();
    }
    this.expect("]");
  }

  parsePseudoClass() {
    const name = this.expectIdentifier("pseudo-class").toLowerCase();
    if (this.eat("(")) {
      if (PSEUDO_SELECTOR_LIST.has(name)) this.parseSelectorList(false);
      else if (PSEUDO_RELATIVE_LIST.has(name)) {
        // :has() cannot be nested, and pseudo-elements are not allowed inside it.
        if (this.inHas) this.fail(":has() inside :has()");
        this.inHas = true;
        this.parseSelectorList(true);
        this.inHas = false;
      }
      else if (PSEUDO_NTH.has(name)) {
        const close = this.text.indexOf(")", this.pos);
        if (close < 0) this.fail("unterminated nth argument");
        const argument = this.text.slice(this.pos, close);
        if (!NTH.test(argument)) this.fail(`unsupported argument for :${name}()`);
        this.pos = close;
      } else this.fail(`unsupported functional pseudo-class :${name}()`);
      this.skipWhitespace();
      this.expect(")");
      return;
    }
    if (LEGACY_PSEUDO_ELEMENTS.has(name) && !this.inHas) return;
    if (!PSEUDO_CLASSES.has(name)) this.fail(`unsupported pseudo-class :${name}`);
  }
}

// Returns null when the selector list is acceptable, otherwise the reason.
export function selectorProblem(selector) {
  if (FORBIDDEN.test(selector)) return "selector contains {, }, /* or url(";
  const parser = new Parser(selector);
  try {
    parser.parseSelectorList(false);
    parser.skipWhitespace();
    if (parser.pos !== selector.length) parser.fail("unexpected text");
  } catch (error) {
    if (error instanceof SelectorError) return error.message;
    throw error;
  }
  return null;
}
