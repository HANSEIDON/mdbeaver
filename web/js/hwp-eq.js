// Hangul equation script → LaTeX, covering the common constructs (fractions, roots, scripts,
// big operators, brackets, matrices, accents, Greek letters, relations). Anything it does not
// know passes through as written, which an AI still reads well.

const GREEK = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega".split(" ");
const WORDS = {
  times: "\\times", div: "\\div", cdot: "\\cdot", cdots: "\\cdots", ldots: "\\ldots", vdots: "\\vdots", ddots: "\\ddots",
  inf: "\\infty", infinity: "\\infty", "+-": "\\pm", "-+": "\\mp", pm: "\\pm", mp: "\\mp",
  le: "\\le", leq: "\\le", "<=": "\\le", ge: "\\ge", geq: "\\ge", ">=": "\\ge", ne: "\\ne", neq: "\\ne", "!=": "\\ne",
  "->": "\\to", "<-": "\\leftarrow", "<->": "\\leftrightarrow", "=>": "\\Rightarrow", "<=>": "\\Leftrightarrow",
  approx: "\\approx", sim: "\\sim", equiv: "\\equiv", "==": "\\equiv", propto: "\\propto",
  in: "\\in", notin: "\\notin", subset: "\\subset", subseteq: "\\subseteq", supset: "\\supset", supseteq: "\\supseteq",
  cup: "\\cup", cap: "\\cap", emptyset: "\\emptyset", forall: "\\forall", exist: "\\exists", exists: "\\exists",
  therefore: "\\therefore", because: "\\because", partial: "\\partial", nabla: "\\nabla", angle: "\\angle",
  triangle: "\\triangle", deg: "^\\circ", prime: "'", circ: "\\circ", bot: "\\perp", perp: "\\perp", parallel: "\\parallel",
  sum: "\\sum", prod: "\\prod", int: "\\int", dint: "\\iint", tint: "\\iiint", oint: "\\oint", lim: "\\lim",
  sin: "\\sin", cos: "\\cos", tan: "\\tan", cot: "\\cot", sec: "\\sec", csc: "\\csc", log: "\\log", ln: "\\ln",
  exp: "\\exp", max: "\\max", min: "\\min", det: "\\det",
};
const ACCENT = { bar: "\\overline", hat: "\\hat", vec: "\\vec", dot: "\\dot", ddot: "\\ddot", tilde: "\\tilde", under: "\\underline", acute: "\\acute", grave: "\\grave" };
const MATRIX = { matrix: "matrix", pmatrix: "pmatrix", bmatrix: "bmatrix", dmatrix: "vmatrix", cases: "cases" };
const CAPITAL = new Set("Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split(" "));
const LATIN = { alpha: "A", beta: "B", epsilon: "E", zeta: "Z", eta: "H", iota: "I", kappa: "K", mu: "M", nu: "N", omicron: "O", rho: "P", tau: "T", chi: "X" };
const FONT = new Set(["rm", "it", "bold", "italic"]);
const OPS = ["<=>", "<->", "->", "<-", "=>", "<=", ">=", "!=", "==", "+-", "-+"];

function tokenize(s) {
  const out = [];
  let i = 0;
  const group = () => { // s[i] is "{"; returns the inner tokens
    i++;
    const inner = [];
    while (i < s.length && s[i] !== "}") inner.push(...one());
    i++;
    return { group: inner };
  };
  const one = () => {
    const c = s[i];
    if (/[\s~`]/.test(c)) { i++; return []; }
    if (c === "{") return [group()];
    if (c === '"') { const j = s.indexOf('"', i + 1); const t = s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1; return [{ text: t }]; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) { i += op.length; return [op]; }
    const w = s.slice(i).match(/^[A-Za-z]+|^\d+(\.\d+)?/);
    if (w) { i += w[0].length; return [w[0]]; }
    i++;
    return [c];
  };
  while (i < s.length) out.push(...one());
  return out;
}

function convert(tokens) {
  const atoms = [];
  let i = 0;
  const next = () => (i < tokens.length ? atom(tokens[i++]) : "");
  const groupOf = (t) => (t?.group ? convert(t.group) : t != null ? atom(t) : "");
  function atom(t) {
    if (t.group) return `{${convert(t.group)}}`;
    if (t.text != null) return `\\text{${t.text}}`;
    const low = t.toLowerCase();
    if (low === "sqrt") return `\\sqrt{${strip(next())}}`;
    if (low === "root") {
      const n = strip(next());
      if (tokens[i]?.toLowerCase?.() === "of") i++;
      return `\\sqrt[${n}]{${strip(next())}}`;
    }
    if (ACCENT[low]) return `${ACCENT[low]}{${strip(next())}}`;
    if (MATRIX[low]) {
      const body = tokens[i]?.group ? convert(tokens[i++].group) : "";
      return `\\begin{${MATRIX[low]}}${body.replace(/#/g, "\\\\")}\\end{${MATRIX[low]}}`;
    }
    if (low === "left" || low === "right") {
      const d = tokens[i++];
      const ch = d?.group ? "\\{" : d === "{" || d === "}" ? `\\${d}` : d ?? ".";
      return `\\${low}${ch}`;
    }
    if (low === "from") return `_${script(strip(next()))}`;
    if (low === "to" && atoms.length) return `^${script(strip(next()))}`;
    if (low === "sup" || t === "^") return `^${script(strip(next()))}`;
    if (low === "sub" || t === "_") return `_${script(strip(next()))}`;
    if (FONT.has(low)) return "";
    if (GREEK.includes(low)) {
      if (t === low) return `\\${low}`;
      const cap = low[0].toUpperCase() + low.slice(1);
      return CAPITAL.has(cap) ? `\\${cap}` : LATIN[low] ?? cap; // no \Alpha in LaTeX: it is a plain A
    }
    if (WORDS[low] ?? WORDS[t]) return (WORDS[low] ?? WORDS[t]) + (/^\\[a-z]+$/i.test(WORDS[low] ?? WORDS[t]) ? " " : "");
    return t;
  }
  while (i < tokens.length) {
    const t = tokens[i++];
    if (typeof t === "string" && t.toLowerCase() === "over" && atoms.length) {
      const num = atoms.pop();
      atoms.push(`\\frac{${strip(num)}}{${strip(groupOf(tokens[i++]))}}`);
      continue;
    }
    atoms.push(atom(t));
  }
  return atoms.join(" ").replace(/\s+([\^_])/g, "$1").replace(/\s+/g, " ").trim();
}

// "{a+b}" → "a+b", but "{a}+{b}" stays whole.
function strip(s) {
  s = s.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return s;
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s;
  }
  return s.slice(1, -1).trim();
}
const script = (s) => (s.length === 1 ? s : `{${s}}`); // x^2, not x^{2}: fewer tokens

export function hwpEquation(script) {
  return convert(tokenize(script));
}
