//! Orca `PlaceholderParser` subset: `[var]`, `[vector_var[index_var]]` and `{expression}` blocks with
//! `{if}{elsif}{else}{endif}` (text and `then` forms), `local`/`global` scalar variables, the arithmetic /
//! comparison / logical / ternary operators and the functions `min max abs? round int floor ceil digits zdigits
//! size empty is_nil one_of`. Semantics follow `PlaceholderParser.cpp` (typed int/double/bool/string values,
//! integer division when both sides are int, `ostream` double formatting, vector index out of range -> element 0).
//!
//! Failures never disappear: an unknown variable or a syntax error produces an `Issue` in the expansion and an
//! empty substitution; the caller (gcode.rs) also writes a `; FDM-UNRESOLVED` comment so the file shows it.
//! Variables in branches that are not taken are never evaluated, so they are not reported (Orca would reject the
//! template at parse time; here the live path is what runs).
//!
//! NOT supported (reported as an Issue when met, never ignored): regular expressions (`=~`, `!~`,
//! `regex_replace`, `/re/` in `one_of`), `random`, `interpolate_table`, `repeat`, vector assignment.

use std::collections::BTreeMap;

use super::settings::{opt_kind, OptKind, Settings};

/// A typed scalar value of the template language.
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Bool(bool),
    Int(i64),
    Dbl(f64),
    Str(String),
}

impl V {
    fn is_num(&self) -> bool { matches!(self, V::Int(_) | V::Dbl(_)) }
    fn as_d(&self) -> f64 { match self { V::Int(i) => *i as f64, V::Dbl(d) => *d, V::Bool(b) => *b as i32 as f64, V::Str(_) => 0.0 } }
    fn as_i(&self) -> i64 { match self { V::Int(i) => *i, V::Dbl(d) => *d as i64, V::Bool(b) => *b as i64, V::Str(_) => 0 } }
    pub fn to_text(&self) -> String {
        match self {
            V::Bool(b) => if *b { "true".into() } else { "false".into() },
            V::Int(i) => i.to_string(),
            V::Dbl(d) => super::fmt_g(*d),
            V::Str(s) => s.clone(),
        }
    }
}

/// An extra (print-state) variable provided by the caller: scalar or vector.
#[derive(Clone, Debug)]
pub enum Extra {
    Scalar(V),
    Vector(Vec<V>),
}

/// Something went wrong while expanding; every issue is retained.
#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub template: String,
    pub message: String,
}

/// Expansion context: the settings, the print-state variables set by the exporter, and the accumulated issues.
pub struct Ctx<'a> {
    pub settings: &'a Settings,
    pub extra: BTreeMap<String, Extra>,
    pub globals: BTreeMap<String, V>,
    pub issues: Vec<Issue>,
    /// Name of the template being expanded (for issue reports).
    pub name: String,
    /// Index of the current "extruder" for un-indexed vector references (always 0 here).
    pub extruder_id: usize,
}

impl<'a> Ctx<'a> {
    pub fn new(settings: &'a Settings) -> Self {
        Ctx { settings, extra: BTreeMap::new(), globals: BTreeMap::new(), issues: Vec::new(), name: String::new(), extruder_id: 0 }
    }
    pub fn set(&mut self, k: &str, v: V) { self.extra.insert(k.to_string(), Extra::Scalar(v)); }
    pub fn set_int(&mut self, k: &str, v: i64) { self.set(k, V::Int(v)); }
    pub fn set_f(&mut self, k: &str, v: f64) { self.set(k, V::Dbl(v)); }
    pub fn set_bool(&mut self, k: &str, v: bool) { self.set(k, V::Bool(v)); }
    pub fn set_str(&mut self, k: &str, v: &str) { self.set(k, V::Str(v.to_string())); }
    pub fn set_vec(&mut self, k: &str, v: Vec<V>) { self.extra.insert(k.to_string(), Extra::Vector(v)); }

    fn issue(&mut self, msg: String) {
        self.issues.push(Issue { template: self.name.clone(), message: msg });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Node {
    Text(String),
    Macro(Vec<Item>),
    Legacy(String, Option<String>),
}

#[derive(Clone, Debug)]
enum Item {
    If(Vec<(Option<Expr>, Vec<Node>, Vec<Item>)>), // (condition, text body, macro body); condition None = else
    Stmt(Expr),
    Assign { name: String, global: bool, new_var: bool, value: Box<Expr> },
}

#[derive(Clone, Debug)]
enum Expr {
    Lit(V),
    Var(String, Option<Box<Expr>>),
    Unary(char, Box<Expr>),
    Bin(String, Box<Expr>, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    OneOf(Box<Expr>, Vec<(bool, Expr)>), // (negated, pattern)
    Unsupported(String),
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

const KEYWORDS: &[&str] = &[
    "and", "digits", "zdigits", "empty", "if", "int", "is_nil", "local", "else", "elsif", "endif", "false", "global",
    "interpolate_table", "min", "max", "random", "regex_replace", "filament_change", "repeat", "round", "floor", "ceil",
    "not", "one_of", "or", "size", "true",
];

type PResult<T> = Result<T, String>;

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> { self.s.get(self.i).copied() }
    fn peek_at(&self, o: usize) -> Option<char> { self.s.get(self.i + o).copied() }
    fn ws(&mut self) { while matches!(self.peek(), Some(c) if c.is_whitespace()) { self.i += 1; } }
    fn eat(&mut self, c: char) -> bool { self.ws(); if self.peek() == Some(c) { self.i += 1; true } else { false } }
    fn expect(&mut self, c: char) -> PResult<()> {
        if self.eat(c) { Ok(()) } else { Err(format!("expected '{}' at offset {}", c, self.i)) }
    }
    fn starts_with(&self, t: &str) -> bool {
        let mut j = self.i;
        for ch in t.chars() { if self.s.get(j) != Some(&ch) { return false; } j += 1; }
        true
    }
    fn ident_at(&self, mut j: usize) -> Option<(String, usize)> {
        let c = *self.s.get(j)?;
        if !(c.is_ascii_alphabetic() || c == '_') { return None; }
        let st = j;
        while let Some(&c) = self.s.get(j) { if c.is_ascii_alphanumeric() || c == '_' { j += 1; } else { break; } }
        Some((self.s[st..j].iter().collect(), j))
    }
    /// Keyword test (distinct: not followed by an identifier char).
    fn kw(&mut self, k: &str) -> bool {
        self.ws();
        if !self.starts_with(k) { return false; }
        match self.s.get(self.i + k.chars().count()) {
            Some(c) if c.is_ascii_alphanumeric() || *c == '_' => false,
            _ => { self.i += k.chars().count(); true }
        }
    }
    fn peek_kw(&mut self, k: &str) -> bool { let save = self.i; let r = self.kw(k); self.i = save; r }

    // ---- text and macros ---------------------------------------------------------------------------------
    /// Parse a text block up to (not including) EOF or a `{` that opens `elsif`/`else`/`endif`.
    fn text_block(&mut self, stop_at_tag: bool) -> PResult<Vec<Node>> {
        let mut out = Vec::new();
        let mut buf = String::new();
        while let Some(c) = self.peek() {
            match c {
                '{' => {
                    if stop_at_tag {
                        let save = self.i;
                        self.i += 1;
                        let is_tag = self.peek_kw("elsif") || self.peek_kw("else") || self.peek_kw("endif");
                        self.i = save;
                        if is_tag { break; }
                    }
                    if !buf.is_empty() { out.push(Node::Text(std::mem::take(&mut buf))); }
                    self.i += 1;
                    let items = self.macro_items()?;
                    self.expect('}')?;
                    out.push(Node::Macro(items));
                }
                '[' => {
                    if !buf.is_empty() { out.push(Node::Text(std::mem::take(&mut buf))); }
                    self.i += 1;
                    self.ws();
                    let (id, j) = self.ident_at(self.i).ok_or_else(|| format!("expecting an identifier after '[' at {}", self.i))?;
                    self.i = j;
                    self.ws();
                    if self.peek() == Some('[') {
                        self.i += 1;
                        self.ws();
                        let (idx, j) = self.ident_at(self.i).ok_or_else(|| "expecting an index identifier".to_string())?;
                        self.i = j;
                        self.expect(']')?;
                        self.expect(']')?;
                        out.push(Node::Legacy(id, Some(idx)));
                    } else {
                        self.expect(']')?;
                        out.push(Node::Legacy(id, None));
                    }
                }
                _ => { buf.push(c); self.i += 1; }
            }
        }
        if !buf.is_empty() { out.push(Node::Text(buf)); }
        Ok(out)
    }

    /// Items of a `{ ... }` macro, up to (not including) the closing '}'.
    fn macro_items(&mut self) -> PResult<Vec<Item>> {
        let mut items = Vec::new();
        loop {
            self.ws();
            while self.peek() == Some(';') { self.i += 1; self.ws(); }
            match self.peek() {
                None => return Err("unterminated '{'".into()),
                Some('}') => break,
                _ => {}
            }
            if self.peek_kw("elsif") || self.peek_kw("else") || self.peek_kw("endif") { break; }
            if self.peek_kw("if") {
                self.kw("if");
                items.push(self.if_block()?);
            } else {
                items.push(self.statement()?);
            }
        }
        Ok(items)
    }

    fn if_block(&mut self) -> PResult<Item> {
        let mut arms: Vec<(Option<Expr>, Vec<Node>, Vec<Item>)> = Vec::new();
        let cond = self.expr()?;
        let (t, m) = self.arm_body()?;
        arms.push((Some(cond), t, m));
        loop {
            if self.kw("elsif") {
                let c = self.expr()?;
                let (t, m) = self.arm_body()?;
                arms.push((Some(c), t, m));
            } else if self.kw("else") {
                let (t, m) = self.arm_body()?;
                arms.push((None, t, m));
            } else if self.kw("endif") {
                break;
            } else {
                return Err(format!("expecting elsif/else/endif at {}", self.i));
            }
        }
        Ok(Item::If(arms))
    }

    /// After a condition: either `then <macros>` or `} text {`.
    fn arm_body(&mut self) -> PResult<(Vec<Node>, Vec<Item>)> {
        if self.kw("then") {
            let m = self.macro_items()?;
            Ok((Vec::new(), m))
        } else {
            self.expect('}')?;
            let t = self.text_block(true)?;
            self.expect('{')?;
            Ok((t, Vec::new()))
        }
    }

    fn statement(&mut self) -> PResult<Item> {
        self.ws();
        let save = self.i;
        let (global, new_var) = if self.kw("local") { (false, true) } else if self.kw("global") { (true, true) } else { (false, false) };
        if new_var {
            self.ws();
            let (id, j) = self.ident_at(self.i).ok_or("expecting an identifier")?;
            self.i = j;
            self.expect('=')?;
            let v = self.expr()?;
            return Ok(Item::Assign { name: id, global, new_var: true, value: Box::new(v) });
        }
        // assignment `name = expr` (but not `==`)
        if let Some((id, j)) = self.ident_at(self.i) {
            if !KEYWORDS.contains(&id.as_str()) {
                let mut k = j;
                while matches!(self.s.get(k), Some(c) if c.is_whitespace()) { k += 1; }
                if self.s.get(k) == Some(&'=') && self.s.get(k + 1) != Some(&'=') && self.s.get(k + 1) != Some(&'~') {
                    self.i = k + 1;
                    let v = self.expr()?;
                    return Ok(Item::Assign { name: id, global: false, new_var: false, value: Box::new(v) });
                }
            }
        }
        self.i = save;
        Ok(Item::Stmt(self.expr()?))
    }

    // ---- expressions -------------------------------------------------------------------------------------
    fn expr(&mut self) -> PResult<Expr> { self.conditional() }

    fn conditional(&mut self) -> PResult<Expr> {
        let c = self.logical_or()?;
        self.ws();
        if self.peek() == Some('?') {
            self.i += 1;
            let a = self.conditional()?;
            self.expect(':')?;
            let b = self.conditional()?;
            return Ok(Expr::Ternary(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn logical_or(&mut self) -> PResult<Expr> {
        let mut l = self.logical_and()?;
        loop {
            self.ws();
            if self.starts_with("||") { self.i += 2; } else if self.kw("or") {} else { break; }
            let r = self.logical_and()?;
            l = Expr::Bin("||".into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn logical_and(&mut self) -> PResult<Expr> {
        let mut l = self.equality()?;
        loop {
            self.ws();
            if self.starts_with("&&") { self.i += 2; } else if self.kw("and") {} else { break; }
            let r = self.equality()?;
            l = Expr::Bin("&&".into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn equality(&mut self) -> PResult<Expr> {
        let mut l = self.relational()?;
        loop {
            self.ws();
            let op = if self.starts_with("==") { "==" } else if self.starts_with("!=") { "!=" } else if self.starts_with("<>") { "!=" }
                else if self.starts_with("=~") || self.starts_with("!~") {
                    // regular expression: skip the /.../ literal and report
                    self.i += 2;
                    self.ws();
                    if self.peek() == Some('/') {
                        self.i += 1;
                        while let Some(c) = self.peek() { self.i += 1; if c == '\\' { self.i += 1; } else if c == '/' { break; } }
                    }
                    l = Expr::Unsupported("regular-expression match".into());
                    continue;
                } else { break };
            self.i += 2;
            let r = self.relational()?;
            l = Expr::Bin(op.into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn relational(&mut self) -> PResult<Expr> {
        let mut l = self.additive()?;
        loop {
            self.ws();
            let op = if self.starts_with("<=") { "<=" } else if self.starts_with(">=") { ">=" }
                else if self.starts_with("<") && !self.starts_with("<>") { "<" } else if self.starts_with(">") { ">" } else { break };
            self.i += op.len();
            let r = self.additive()?;
            l = Expr::Bin(op.into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn additive(&mut self) -> PResult<Expr> {
        let mut l = self.multiplicative()?;
        loop {
            self.ws();
            let op = match self.peek() { Some('+') => "+", Some('-') => "-", _ => break };
            self.i += 1;
            let r = self.multiplicative()?;
            l = Expr::Bin(op.into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn multiplicative(&mut self) -> PResult<Expr> {
        let mut l = self.unary()?;
        loop {
            self.ws();
            let op = match self.peek() { Some('*') => "*", Some('/') => "/", Some('%') => "%", _ => break };
            self.i += 1;
            let r = self.unary()?;
            l = Expr::Bin(op.into(), Box::new(l), Box::new(r));
        }
        Ok(l)
    }

    fn call_args(&mut self) -> PResult<Vec<Expr>> {
        self.expect('(')?;
        let mut args = Vec::new();
        self.ws();
        if self.peek() == Some(')') { self.i += 1; return Ok(args); }
        loop {
            args.push(self.expr()?);
            self.ws();
            match self.peek() {
                Some(',') => { self.i += 1; }
                Some(')') => { self.i += 1; break; }
                _ => return Err(format!("expected ',' or ')' at {}", self.i)),
            }
        }
        Ok(args)
    }

    fn unary(&mut self) -> PResult<Expr> {
        self.ws();
        match self.peek() {
            None => return Err("unexpected end of expression".into()),
            Some('(') => { self.i += 1; let e = self.expr()?; self.expect(')')?; return Ok(e); }
            Some('-') => { self.i += 1; let e = self.unary()?; return Ok(Expr::Unary('-', Box::new(e))); }
            Some('+') => { self.i += 1; return self.unary(); }
            Some('!') if self.peek_at(1) != Some('=') => { self.i += 1; let e = self.unary()?; return Ok(Expr::Unary('!', Box::new(e))); }
            Some('"') => {
                self.i += 1;
                let mut s = String::new();
                loop {
                    match self.peek() {
                        None => return Err("unterminated string".into()),
                        Some('"') => { self.i += 1; break; }
                        Some('\\') => { self.i += 1; if let Some(c) = self.peek() { s.push(c); self.i += 1; } }
                        Some(c) => { s.push(c); self.i += 1; }
                    }
                }
                return Ok(Expr::Lit(V::Str(s)));
            }
            Some(c) if c.is_ascii_digit() || c == '.' => return self.number(),
            _ => {}
        }
        if self.kw("not") { let e = self.unary()?; return Ok(Expr::Unary('!', Box::new(e))); }
        if self.kw("true") { return Ok(Expr::Lit(V::Bool(true))); }
        if self.kw("false") { return Ok(Expr::Lit(V::Bool(false))); }
        for f in ["min", "max", "round", "int", "floor", "ceil", "digits", "zdigits", "size", "empty", "is_nil"] {
            if self.peek_kw(f) {
                self.kw(f);
                let a = if matches!(f, "size" | "empty" | "is_nil") {
                    // variable reference argument
                    self.expect('(')?;
                    let r = self.var_ref()?;
                    self.expect(')')?;
                    vec![r]
                } else { self.call_args()? };
                return Ok(Expr::Call(f.into(), a));
            }
        }
        if self.peek_kw("one_of") {
            self.kw("one_of");
            self.expect('(')?;
            let subject = self.unary()?;
            let mut pats = Vec::new();
            loop {
                self.ws();
                if self.peek() == Some(',') { self.i += 1; self.ws(); }
                if self.peek() == Some(')') { self.i += 1; break; }
                if self.peek() == Some('/') {
                    self.i += 1;
                    while let Some(c) = self.peek() { self.i += 1; if c == '\\' { self.i += 1; } else if c == '/' { break; } }
                    pats.push((false, Expr::Unsupported("one_of regular expression".into())));
                    continue;
                }
                let neg = if self.peek() == Some('~') { self.i += 1; true } else { false };
                pats.push((neg, self.unary()?));
            }
            return Ok(Expr::OneOf(Box::new(subject), pats));
        }
        for f in ["random", "regex_replace", "filament_change", "interpolate_table", "repeat"] {
            if self.peek_kw(f) {
                self.kw(f);
                // swallow the argument list so parsing can continue
                self.expect('(')?;
                let mut depth = 1;
                while let Some(c) = self.peek() { self.i += 1; if c == '(' { depth += 1; } else if c == ')' { depth -= 1; if depth == 0 { break; } } }
                return Ok(Expr::Unsupported(f.into()));
            }
        }
        self.var_ref()
    }

    fn var_ref(&mut self) -> PResult<Expr> {
        self.ws();
        let (id, j) = self.ident_at(self.i).ok_or_else(|| format!("expecting an expression at offset {}", self.i))?;
        if KEYWORDS.contains(&id.as_str()) { return Err(format!("unexpected keyword '{}'", id)); }
        self.i = j;
        self.ws();
        if self.peek() == Some('[') {
            self.i += 1;
            let idx = self.additive()?;
            self.expect(']')?;
            return Ok(Expr::Var(id, Some(Box::new(idx))));
        }
        Ok(Expr::Var(id, None))
    }

    fn number(&mut self) -> PResult<Expr> {
        let st = self.i;
        let mut is_d = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() { self.i += 1; }
            else if c == '.' && !is_d { is_d = true; self.i += 1; }
            else if (c == 'e' || c == 'E') && is_d {
                // exponent
                let n = self.peek_at(1);
                if matches!(n, Some(d) if d.is_ascii_digit() || d == '-' || d == '+') { self.i += 2; } else { break; }
            } else { break; }
        }
        let t: String = self.s[st..self.i].iter().collect();
        if is_d { t.parse::<f64>().map(|d| Expr::Lit(V::Dbl(d))).map_err(|_| format!("bad number '{}'", t)) }
        else { t.parse::<i64>().map(|d| Expr::Lit(V::Int(d))).map_err(|_| format!("bad number '{}'", t)) }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------

enum Val {
    S(V),
    Vec(Vec<V>),
}

fn typed_from_setting(key: &str, kind: OptKind, raw: &str) -> V {
    match kind {
        OptKind::Float | OptKind::Percent => V::Dbl(raw.trim().trim_end_matches('%').parse::<f64>().unwrap_or(0.0)),
        OptKind::Int => V::Int(raw.trim().parse::<f64>().map(|d| d as i64).unwrap_or(0)),
        OptKind::Bool => V::Bool(matches!(raw.trim(), "1" | "true")),
        OptKind::FloatOrPercent => V::Dbl(raw.trim().trim_end_matches('%').parse::<f64>().unwrap_or(0.0)),
        OptKind::Str | OptKind::Enum | OptKind::Point => V::Str(super::settings::unescape(raw)),
        OptKind::Unknown => {
            let t = raw.trim();
            if let Ok(i) = t.parse::<i64>() { V::Int(i) }
            else if let Ok(d) = t.parse::<f64>() { V::Dbl(d) }
            else { let _ = key; V::Str(super::settings::unescape(t)) }
        }
    }
}

impl<'a> Ctx<'a> {
    fn resolve(&self, name: &str) -> Option<Val> {
        if let Some(v) = self.globals.get(name) { return Some(Val::S(v.clone())); }
        if let Some(e) = self.extra.get(name) {
            return Some(match e { Extra::Scalar(v) => Val::S(v.clone()), Extra::Vector(v) => Val::Vec(v.clone()) });
        }
        let raw = self.settings.raw(name)?;
        let (kind, vec) = opt_kind(name);
        if vec {
            let elems = self.settings.elements(name);
            let vals: Vec<V> = elems.iter().map(|e| typed_from_setting(name, kind, e)).collect();
            Some(Val::Vec(vals))
        } else {
            Some(Val::S(typed_from_setting(name, kind, raw)))
        }
    }
}

fn arith(op: &str, a: &V, b: &V) -> Result<V, String> {
    if op == "+" {
        if let V::Str(x) = a { return Ok(V::Str(format!("{}{}", x, b.to_text()))); }
        if let V::Str(y) = b { return Ok(V::Str(format!("{}{}", a.to_text(), y))); }
    }
    if !a.is_num() || !b.is_num() { return Err(format!("operator {} needs numeric operands", op)); }
    let both_int = matches!((a, b), (V::Int(_), V::Int(_)));
    Ok(match op {
        "+" => if both_int { V::Int(a.as_i() + b.as_i()) } else { V::Dbl(a.as_d() + b.as_d()) },
        "-" => if both_int { V::Int(a.as_i() - b.as_i()) } else { V::Dbl(a.as_d() - b.as_d()) },
        "*" => if both_int { V::Int(a.as_i() * b.as_i()) } else { V::Dbl(a.as_d() * b.as_d()) },
        "/" => {
            if b.as_d() == 0.0 { return Err("division by zero".into()); }
            if both_int { V::Int(a.as_i() / b.as_i()) } else { V::Dbl(a.as_d() / b.as_d()) }
        }
        "%" => {
            if b.as_d() == 0.0 { return Err("division by zero".into()); }
            if both_int { V::Int(a.as_i() % b.as_i()) } else { V::Dbl(a.as_d() % b.as_d()) }
        }
        _ => return Err(format!("unknown operator {}", op)),
    })
}

fn compare(op: &str, a: &V, b: &V) -> Result<V, String> {
    let (core, inv) = match op { "==" => ('=', false), "!=" => ('=', true), "<" => ('<', false), ">" => ('>', false), "<=" => ('>', true), ">=" => ('<', true), _ => return Err("bad compare".into()) };
    let val = if a.is_num() && b.is_num() {
        let dbl = matches!(a, V::Dbl(_)) || matches!(b, V::Dbl(_));
        match core {
            '=' => if dbl { (a.as_d() - b.as_d()).abs() < 1e-8 } else { a.as_i() == b.as_i() },
            '<' => if dbl { a.as_d() < b.as_d() } else { a.as_i() < b.as_i() },
            _ => if dbl { a.as_d() > b.as_d() } else { a.as_i() > b.as_i() },
        }
    } else if let (V::Bool(x), V::Bool(y)) = (a, b) {
        if core != '=' { return Err("cannot compare booleans".into()); }
        x == y
    } else if matches!(a, V::Str(_)) || matches!(b, V::Str(_)) {
        let (x, y) = (a.to_text(), b.to_text());
        match core { '=' => x == y, '<' => x < y, _ => x > y }
    } else {
        return Err("cannot compare these types".into());
    };
    Ok(V::Bool(if inv { !val } else { val }))
}

struct Eval<'c, 'a> { ctx: &'c mut Ctx<'a>, locals: BTreeMap<String, V> }

impl<'c, 'a> Eval<'c, 'a> {
    fn lookup_scalar(&mut self, name: &str, idx: Option<&Expr>) -> Result<V, String> {
        let index: Option<i64> = match idx { Some(e) => { let v = self.eval(e)?; if !v.is_num() { return Err("vector index is not numeric".into()); } Some(v.as_i()) } None => None };
        if let Some(v) = self.locals.get(name) { return Ok(v.clone()); }
        match self.ctx.resolve(name) {
            None => Err(format!("unresolved variable '{}'", name)),
            Some(Val::S(v)) => Ok(v),
            Some(Val::Vec(vs)) => {
                if vs.is_empty() { return Err(format!("indexing an empty vector variable '{}'", name)); }
                let i = match index { Some(i) if i >= 0 && (i as usize) < vs.len() => i as usize, Some(_) => 0, None => self.ctx.extruder_id.min(vs.len() - 1) };
                Ok(vs[i].clone())
            }
        }
    }

    fn eval(&mut self, e: &Expr) -> Result<V, String> {
        Ok(match e {
            Expr::Lit(v) => v.clone(),
            Expr::Var(n, idx) => self.lookup_scalar(n, idx.as_deref())?,
            Expr::Unary('-', a) => match self.eval(a)? { V::Int(i) => V::Int(-i), V::Dbl(d) => V::Dbl(-d), _ => return Err("cannot negate".into()) },
            Expr::Unary(_, a) => match self.eval(a)? { V::Bool(b) => V::Bool(!b), _ => return Err("cannot apply 'not' to a non-boolean".into()) },
            Expr::Bin(op, a, b) => {
                match op.as_str() {
                    "&&" | "||" => {
                        let x = self.eval(a)?;
                        let V::Bool(xb) = x else { return Err("logical operator on a non-boolean".into()) };
                        // Orca evaluates both sides; short-circuit is equivalent for pure expressions.
                        let y = self.eval(b)?;
                        let V::Bool(yb) = y else { return Err("logical operator on a non-boolean".into()) };
                        V::Bool(if op == "&&" { xb && yb } else { xb || yb })
                    }
                    "==" | "!=" | "<" | ">" | "<=" | ">=" => { let x = self.eval(a)?; let y = self.eval(b)?; compare(op, &x, &y)? }
                    _ => { let x = self.eval(a)?; let y = self.eval(b)?; arith(op, &x, &y)? }
                }
            }
            Expr::Ternary(c, a, b) => match self.eval(c)? { V::Bool(true) => self.eval(a)?, V::Bool(false) => self.eval(b)?, _ => return Err("ternary condition is not boolean".into()) },
            Expr::Call(f, args) => self.call(f, args)?,
            Expr::OneOf(s, pats) => {
                let subj = self.eval(s)?;
                let V::Str(subject) = subj else { return Err("one_of(): first parameter has to be a string".into()) };
                let mut hit = false;
                for (neg, p) in pats {
                    if let Expr::Unsupported(w) = p { return Err(format!("{} is not supported", w)); }
                    let pv = self.eval(p)?;
                    let V::Str(ps) = pv else { return Err("one_of(): pattern has to be a string".into()) };
                    let m = subject == ps;
                    if (!neg && m) || (*neg && !m) { hit = true; break; }
                }
                V::Bool(hit)
            }
            Expr::Unsupported(w) => return Err(format!("{} is not supported by this placeholder parser", w)),
        })
    }

    fn call(&mut self, f: &str, args: &[Expr]) -> Result<V, String> {
        match f {
            "min" | "max" => {
                let a = self.eval(&args[0])?; let b = self.eval(&args[1])?;
                if !a.is_num() || !b.is_num() { return Err(format!("{}() needs numeric operands", f)); }
                if matches!(a, V::Dbl(_)) || matches!(b, V::Dbl(_)) {
                    Ok(V::Dbl(if f == "min" { a.as_d().min(b.as_d()) } else { a.as_d().max(b.as_d()) }))
                } else {
                    Ok(V::Int(if f == "min" { a.as_i().min(b.as_i()) } else { a.as_i().max(b.as_i()) }))
                }
            }
            "round" => { let a = self.eval(&args[0])?; if !a.is_num() { return Err("round() of a non-number".into()); } Ok(V::Int(match a { V::Int(i) => i, v => v.as_d().round() as i64 })) }
            "int" => { let a = self.eval(&args[0])?; if !a.is_num() { return Err("int() of a non-number".into()); } Ok(V::Int(a.as_i())) }
            "floor" => { let a = self.eval(&args[0])?; if !a.is_num() { return Err("floor() of a non-number".into()); } Ok(V::Int(match a { V::Int(i) => i, v => v.as_d().floor() as i64 })) }
            "ceil" => { let a = self.eval(&args[0])?; if !a.is_num() { return Err("ceil() of a non-number".into()); } Ok(V::Int(match a { V::Int(i) => i, v => v.as_d().ceil() as i64 })) }
            "digits" | "zdigits" => {
                let a = self.eval(&args[0])?; let w = self.eval(&args[1])?;
                let dec = if args.len() > 2 { Some(self.eval(&args[2])?) } else { None };
                let nd = w.as_i().clamp(0, 64) as usize;
                let lz = f == "zdigits";
                let s = match dec {
                    Some(d) => { let dd = d.as_i().clamp(0, 64) as usize; if lz { format!("{:0w$.p$}", a.as_d(), w = nd, p = dd) } else { format!("{:w$.p$}", a.as_d(), w = nd, p = dd) } }
                    None => { let i = match a { V::Int(i) => i, v => v.as_d().round() as i64 }; if lz { format!("{:0w$}", i, w = nd) } else { format!("{:w$}", i, w = nd) } }
                };
                Ok(V::Str(s))
            }
            "size" | "empty" | "is_nil" => {
                let Expr::Var(n, _) = &args[0] else { return Err("size/empty/is_nil need a variable".into()) };
                let len = match self.ctx.resolve(n) { Some(Val::Vec(v)) => v.len(), Some(Val::S(_)) => 1, None => return Err(format!("unresolved variable '{}'", n)) };
                match f { "size" => Ok(V::Int(len as i64)), "empty" => Ok(V::Bool(len == 0)), _ => Ok(V::Bool(false)) }
            }
            _ => Err(format!("function {} is not supported", f)),
        }
    }

    fn run_nodes(&mut self, nodes: &[Node], out: &mut String) {
        for n in nodes {
            match n {
                Node::Text(t) => out.push_str(t),
                Node::Macro(items) => self.run_items(items, out),
                Node::Legacy(name, idx) => match self.legacy(name, idx.as_deref()) {
                    Ok(s) => out.push_str(&s),
                    Err(m) => self.ctx.issue(m),
                },
            }
        }
    }

    fn legacy(&mut self, name: &str, idx: Option<&str>) -> Result<String, String> {
        // `[name]` -> serialized option value; `[vec[idxvar]]` -> element; `[vec_N]` -> element N.
        let mut name_s = name.to_string();
        let mut elem: Option<usize> = None;
        if let Some(iv) = idx {
            let iv_val = self.lookup_scalar(iv, None)?;
            if !matches!(iv_val, V::Int(_)) { return Err(format!("indexing variable '{}' has to be integer", iv)); }
            let i = iv_val.as_i();
            if i < 0 { return Err("negative vector index".into()); }
            elem = Some(i as usize);
        } else if !self.ctx.extra.contains_key(&name_s) && !self.ctx.settings.has(&name_s) && !self.locals.contains_key(&name_s) {
            if let Some(p) = name_s.rfind('_') {
                if let Ok(n) = name_s[p + 1..].parse::<usize>() {
                    elem = Some(n);
                    name_s.truncate(p);
                }
            }
        }
        if let Some(e) = self.ctx.extra.get(&name_s) {
            return Ok(match e {
                Extra::Scalar(v) => v.to_text(),
                Extra::Vector(vs) => {
                    if vs.is_empty() { return Err(format!("indexing an empty vector variable '{}'", name_s)); }
                    let i = elem.unwrap_or(self.ctx.extruder_id); vs[if i < vs.len() { i } else { 0 }].to_text()
                }
            });
        }
        if let Some(v) = self.locals.get(&name_s) { return Ok(v.to_text()); }
        if let Some(v) = self.ctx.globals.get(&name_s) { return Ok(v.to_text()); }
        let Some(raw) = self.ctx.settings.raw(&name_s) else { return Err(format!("unresolved variable '{}'", name_s)) };
        let (kind, vec) = opt_kind(&name_s);
        if vec {
            let el = self.ctx.settings.elements(&name_s);
            if el.is_empty() { return Err(format!("indexing an empty vector variable '{}'", name_s)); }
            let i = elem.unwrap_or(self.ctx.extruder_id);
            let e = &el[if i < el.len() { i } else { 0 }];
            Ok(if kind == OptKind::Str { super::settings::unescape(e) } else { e.clone() })
        } else if kind == OptKind::Str || kind == OptKind::Enum {
            Ok(super::settings::unescape(raw.trim_matches('"')))
        } else {
            Ok(raw.to_string())
        }
    }

    fn run_items(&mut self, items: &[Item], out: &mut String) {
        for it in items {
            match it {
                Item::Stmt(e) => match self.eval(e) {
                    Ok(v) => out.push_str(&v.to_text()),
                    Err(m) => self.ctx.issue(m),
                },
                Item::Assign { name, global, new_var, value } => match self.eval(value) {
                    Ok(v) => {
                        if *global { self.ctx.globals.insert(name.clone(), v); }
                        else if *new_var || self.locals.contains_key(name) { self.locals.insert(name.clone(), v); }
                        else if self.ctx.globals.contains_key(name) { self.ctx.globals.insert(name.clone(), v); }
                        else { self.ctx.issue(format!("assignment to read-only or unknown variable '{}'", name)); }
                    }
                    Err(m) => self.ctx.issue(m),
                },
                Item::If(arms) => {
                    for (cond, text, macros) in arms {
                        let take = match cond {
                            None => true,
                            Some(c) => match self.eval(c) {
                                Ok(V::Bool(b)) => b,
                                Ok(_) => { self.ctx.issue("condition is not a boolean expression".into()); false }
                                Err(m) => { self.ctx.issue(m); false }
                            },
                        };
                        if take {
                            self.run_nodes(text, out);
                            self.run_items(macros, out);
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// Expand `templ` against `ctx`. Issues are appended to `ctx.issues`.
pub fn expand(templ: &str, ctx: &mut Ctx) -> String {
    let chars: Vec<char> = templ.chars().collect();
    let mut p = Parser { s: &chars, i: 0 };
    let nodes = match p.text_block(false) {
        Ok(n) if p.i >= chars.len() => n,
        Ok(_) => { ctx.issue(format!("syntax error near offset {}", p.i)); return String::new(); }
        Err(m) => { ctx.issue(format!("syntax error: {}", m)); return String::new(); }
    };
    let mut out = String::new();
    let mut ev = Eval { ctx, locals: BTreeMap::new() };
    ev.run_nodes(&nodes, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(t: &str, s: &Settings, setup: impl FnOnce(&mut Ctx)) -> (String, Vec<Issue>) {
        let mut c = Ctx::new(s);
        setup(&mut c);
        let o = expand(t, &mut c);
        (o, c.issues.clone())
    }

    #[test]
    fn arithmetic_and_formatting() {
        let s = Settings::from_config_block("; first_x_layer_fan_speed = 40\n; close_additional_fan_first_x_layers = 3\n; nozzle_temperature_initial_layer = 240\n; filament_type = PETG\n");
        let (o, i) = run("M106 P2 S{first_x_layer_fan_speed[current_filament_id]*255.0/100.0}\n", &s, |c| c.set_int("current_filament_id", 0));
        assert_eq!(o, "M106 P2 S102\n"); assert!(i.is_empty(), "{:?}", i);
        let (o, _) = run("M104 S{nozzle_temperature_initial_layer[0]-40} A", &s, |_| {});
        assert_eq!(o, "M104 S200 A");
        let (o, _) = run("{if layer_num + 1 == 1}first{elsif layer_num == 5}five{else}other{endif}!", &s, |c| c.set_int("layer_num", 0));
        assert_eq!(o, "first!");
        let (o, _) = run("{if layer_num + 1 == 1}first{elsif layer_num == 5}five{else}other{endif}!", &s, |c| c.set_int("layer_num", 5));
        assert_eq!(o, "five!");
        let (o, _) = run("{if filament_type[0] == \"PETG\" || filament_type[0] == \"PLA\"}ok{endif}", &s, |_| {});
        assert_eq!(o, "ok");
        let (o, _) = run("G29.1 Z{+0.0} Z{-0.003} X{1/3.0}", &s, |_| {});
        assert_eq!(o, "G29.1 Z0 Z-0.003 X0.333333");
        let (o, _) = run("[nozzle_temperature_initial_layer] [filament_type]", &s, |_| {});
        assert_eq!(o, "240 PETG");
    }

    #[test]
    fn unresolved_is_reported_not_dropped() {
        let s = Settings::new();
        let (o, i) = run("A{if no_such_var > 1}x{endif}B[no_such_legacy]", &s, |_| {});
        assert_eq!(o, "AB");
        assert_eq!(i.len(), 2, "{:?}", i);
        assert!(i[0].message.contains("no_such_var"));
        assert!(i[1].message.contains("no_such_legacy"));
        // nested ternary + skipped branch is not evaluated
        let (o, i) = run("{true ? 1 : bogus}", &s, |_| {});
        assert_eq!(o, "1"); assert!(i.is_empty());
    }

    #[test]
    fn ternary_chain_and_locals() {
        let s = Settings::new();
        let (o, i) = run("{local a = 3; a * 2}{layer_z + (farthest ? 0.0 : 0.4)}", &s, |c| { c.set_f("layer_z", 0.2); c.set_bool("farthest", false); });
        assert_eq!(o, "60.6", "{:?}", i);
    }
}
