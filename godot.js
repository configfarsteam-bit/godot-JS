/*!
 * godot.js — an unofficial, Godot-inspired, web-native game engine runtime.
 * Reference semantics: Godot Engine 4.7.2 (stable, 2026-08-18) class reference.
 * NOT affiliated with or endorsed by the Godot Engine project. "Godot" is a trademark
 * of the Godot Foundation; Godot itself is MIT-licensed. This file contains no Godot source code.
 * License of this file: MIT.
 *
 * TABLE OF CONTENTS
 *   §0  Bootstrap, config (debug/production), error codes
 *   §1  Logging & diagnostics
 *   §2  Math: utilities, Vector2/3/4, Quaternion, Basis, Transform2D/3D, AABB, Rect2, Color, Plane, Mat4
 *   §3  Object model: ObjectDB, ClassDB, Callable, signals, MessageQueue, Resource
 *   §4  Engine main loop (rAF, fixed physics step, time scale, pause, delta clamp)
 *   §5  Scene: NodePath, Node, SceneTree, groups, Node2D/Node3D, PackedScene
 *   §6  Rendering: backend abstraction, WebGL2 backend, GPU resource tracking,
 *       textures, meshes, materials, lights, cameras, 3D renderer (shadows/instancing/culling),
 *       2D canvas renderer (Sprite2D batching)
 *   §7  Physics 3D: shapes, broad-phase (SAP), narrow-phase, sequential-impulse solver,
 *       Static/Rigid/Character bodies, Area3D, space queries
 *   §8  Input: events, InputMap, Input singleton (keyboard/pointer/touch/gamepad)
 *   §9  Animation: Animation, AnimationPlayer, Tween, Timer, SceneTreeTimer
 *   §10 Assets: ResourceLoader (states/cache/dedup/cancel), IndexedDB storage
 *   §11 Audio: AudioServer buses, AudioStream, AudioStreamPlayer/3D, autoplay unlock
 *   §12 Extras: WebGPU backend, CPU particles, serialization, networking, UI, profiler
 *   §13 Public namespace export
 *
 * Dependency direction (lower never imports higher): §1 → §2 → §3 → §4 → §5 → §6..§12 → §13.
 */
(function (global) {
'use strict';
if (global.GodotJS) { console.warn('[godot.js] already loaded; keeping the first instance.'); return; }

// §0 ─────────────────────────────────────────────────────────────────────────
const VERSION = '0.1.0';
const GODOT_REFERENCE_VERSION = '4.7.2';
const Config = {
  // debug: argument validation, gl.getError() after GPU calls, verbose diagnostics.
  debug: true,
};
// Values match @GlobalScope.Error.
const Err = Object.freeze({
  OK: 0, FAILED: 1, ERR_UNAVAILABLE: 2, ERR_UNCONFIGURED: 3, ERR_CANT_OPEN: 19, ERR_CANT_CREATE: 20, ERR_ALREADY_IN_USE: 22, ERR_TIMEOUT: 24,
  ERR_CANT_CONNECT: 25, ERR_CONNECTION_ERROR: 27, ERR_INVALID_DATA: 30, ERR_INVALID_PARAMETER: 31,
  ERR_ALREADY_EXISTS: 32, ERR_DOES_NOT_EXIST: 33, ERR_BUSY: 44,
});
const _ext = {}; // later sections add public symbols here
const now = () => (global.performance ? global.performance.now() : Date.now());

// §1 ─────────────────────────────────────────────────────────────────────────
const LogLevel = Object.freeze({ VERBOSE: 0, INFO: 1, WARNING: 2, ERROR: 3, NONE: 4 });
const Log = {
  level: LogLevel.INFO,
  history: [],
  maxHistory: 500,
  counts: { verbose: 0, info: 0, warning: 0, error: 0 },
  _sinks: new Set(),
  add_sink(fn) { this._sinks.add(fn); return () => this._sinks.delete(fn); },
  _emit(level, tag, args) {
    const name = level === 0 ? 'verbose' : level === 1 ? 'info' : level === 2 ? 'warning' : 'error';
    this.counts[name]++;
    const entry = { level, tag, time: now(), message: args.map(Log._fmt).join(' ') };
    const err = args.find((a) => a instanceof Error);
    if (err) entry.stack = err.stack;
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const s of this._sinks) { try { s(entry); } catch (e) { console.error('[godot.js] log sink failed', e); } }
    if (level < this.level) return;
    const prefix = '[godot.js' + (tag ? ':' + tag : '') + ']';
    if (level >= LogLevel.ERROR) console.error(prefix, ...args);
    else if (level === LogLevel.WARNING) console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  },
  _fmt(a) {
    if (a instanceof Error) return a.message;
    if (a && typeof a === 'object' && typeof a.toString === 'function' && a.toString !== Object.prototype.toString) return a.toString();
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
    return String(a);
  },
  verbose(...a) { this._emit(0, '', a); },
  print(...a) { this._emit(1, '', a); },
  warn(...a) { this._emit(2, '', a); },
  error(...a) { this._emit(3, '', a); },
  tagged(tag) {
    return {
      verbose: (...a) => Log._emit(0, tag, a), print: (...a) => Log._emit(1, tag, a),
      warn: (...a) => Log._emit(2, tag, a), error: (...a) => Log._emit(3, tag, a),
    };
  },
  clear() { this.history.length = 0; for (const k in this.counts) this.counts[k] = 0; },
};

// §2 ─────────────────────────────────────────────────────────────────────────
const CMP_EPSILON = 0.00001;
const MathUtil = {
  PI: Math.PI, TAU: Math.PI * 2, CMP_EPSILON,
  clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
  lerp: (a, b, t) => a + (b - a) * t,
  inverse_lerp: (a, b, v) => (v - a) / (b - a),
  remap: (v, i0, i1, o0, o1) => o0 + (o1 - o0) * ((v - i0) / (i1 - i0)),
  deg_to_rad: (d) => d * (Math.PI / 180),
  rad_to_deg: (r) => r * (180 / Math.PI),
  move_toward: (from, to, delta) => (Math.abs(to - from) <= delta ? to : from + Math.sign(to - from) * delta),
  is_equal_approx(a, b) {
    if (a === b) return true;
    let tol = CMP_EPSILON * Math.abs(a); if (tol < CMP_EPSILON) tol = CMP_EPSILON;
    return Math.abs(a - b) < tol;
  },
  is_zero_approx: (a) => Math.abs(a) < CMP_EPSILON,
  wrapf(v, min, max) { const r = max - min; return r === 0 ? min : v - r * Math.floor((v - min) / r); },
  fposmod(x, y) { let v = x % y; if ((v < 0 && y > 0) || (v > 0 && y < 0)) v += y; return v; },
  lerp_angle(from, to, w) { const d = MathUtil.fposmod(to - from, Math.PI * 2); const dist = MathUtil.fposmod(2 * d, Math.PI * 2) - d; return from + dist * w; },
  // Same polynomial as Godot's Math::cubic_interpolate (Catmull-Rom style).
  cubic_interpolate(from, to, pre, post, w) {
    return 0.5 * ((from * 2.0) + (-pre + to) * w + (2.0 * pre - 5.0 * from + 4.0 * to - post) * (w * w) + (-pre + 3.0 * from - 3.0 * to + post) * (w * w * w));
  },
  smoothstep(a, b, x) { if (a === b) return x < a ? 0 : 1; const t = MathUtil.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
  snapped(v, step) { return step !== 0 ? Math.floor(v / step + 0.5) * step : v; },
};

class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  static get ZERO() { return new Vector2(0, 0); } static get ONE() { return new Vector2(1, 1); }
  static get UP() { return new Vector2(0, -1); } static get DOWN() { return new Vector2(0, 1); }
  static get LEFT() { return new Vector2(-1, 0); } static get RIGHT() { return new Vector2(1, 0); }
  static from_angle(a) { return new Vector2(Math.cos(a), Math.sin(a)); }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
  clone() { return new Vector2(this.x, this.y); }
  add(v) { return new Vector2(this.x + v.x, this.y + v.y); }
  sub(v) { return new Vector2(this.x - v.x, this.y - v.y); }
  mul(s) { return typeof s === 'number' ? new Vector2(this.x * s, this.y * s) : new Vector2(this.x * s.x, this.y * s.y); }
  div(s) { return typeof s === 'number' ? new Vector2(this.x / s, this.y / s) : new Vector2(this.x / s.x, this.y / s.y); }
  neg() { return new Vector2(-this.x, -this.y); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  cross(v) { return this.x * v.y - this.y * v.x; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  length_squared() { return this.x * this.x + this.y * this.y; }
  normalized() { const l = this.length(); return l === 0 ? new Vector2() : new Vector2(this.x / l, this.y / l); }
  is_normalized() { return MathUtil.is_equal_approx(this.length_squared(), 1); }
  distance_to(v) { return Math.hypot(this.x - v.x, this.y - v.y); }
  distance_squared_to(v) { const dx = this.x - v.x, dy = this.y - v.y; return dx * dx + dy * dy; }
  angle() { return Math.atan2(this.y, this.x); }
  angle_to(v) { return Math.atan2(this.cross(v), this.dot(v)); }
  angle_to_point(p) { return Math.atan2(p.y - this.y, p.x - this.x); }
  rotated(a) { const c = Math.cos(a), s = Math.sin(a); return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c); }
  lerp(v, t) { return new Vector2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t); }
  move_toward(to, d) { const v = to.sub(this); const l = v.length(); return l <= d || l < CMP_EPSILON ? to.clone() : this.add(v.mul(d / l)); }
  limit_length(len = 1) { const l = this.length(); return l > 0 && len < l ? this.mul(len / l) : this.clone(); }
  abs() { return new Vector2(Math.abs(this.x), Math.abs(this.y)); }
  floor() { return new Vector2(Math.floor(this.x), Math.floor(this.y)); }
  round() { return new Vector2(Math.round(this.x), Math.round(this.y)); }
  orthogonal() { return new Vector2(this.y, -this.x); }
  slide(n) { return this.sub(n.mul(this.dot(n))); }
  bounce(n) { return this.reflect(n).neg(); }
  reflect(n) { return n.mul(2 * this.dot(n)).sub(this); }
  is_equal_approx(v) { return MathUtil.is_equal_approx(this.x, v.x) && MathUtil.is_equal_approx(this.y, v.y); }
  equals(v) { return this.x === v.x && this.y === v.y; }
  toArray() { return [this.x, this.y]; }
  toString() { return `(${this.x}, ${this.y})`; }
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static get ZERO() { return new Vector3(0, 0, 0); } static get ONE() { return new Vector3(1, 1, 1); }
  static get UP() { return new Vector3(0, 1, 0); } static get DOWN() { return new Vector3(0, -1, 0); }
  static get LEFT() { return new Vector3(-1, 0, 0); } static get RIGHT() { return new Vector3(1, 0, 0); }
  static get FORWARD() { return new Vector3(0, 0, -1); } static get BACK() { return new Vector3(0, 0, 1); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z); }
  mul(s) { return typeof s === 'number' ? new Vector3(this.x * s, this.y * s, this.z * s) : new Vector3(this.x * s.x, this.y * s.y, this.z * s.z); }
  div(s) { return typeof s === 'number' ? new Vector3(this.x / s, this.y / s, this.z / s) : new Vector3(this.x / s.x, this.y / s.y, this.z / s.z); }
  neg() { return new Vector3(-this.x, -this.y, -this.z); }
  // In-place variants for hot paths (no allocation).
  iadd(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  isub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  iscale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  iadd_scaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  set_sub(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  set_cross(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
  inormalize() { const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); if (l > 0) { this.x /= l; this.y /= l; this.z /= l; } return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return new Vector3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  length_squared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalized() { const l = this.length(); return l === 0 ? new Vector3() : new Vector3(this.x / l, this.y / l, this.z / l); }
  is_normalized() { return MathUtil.is_equal_approx(this.length_squared(), 1); }
  distance_to(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  distance_squared_to(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  angle_to(v) { return Math.atan2(this.cross(v).length(), this.dot(v)); }
  lerp(v, t) { return new Vector3(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
  rotated(axis, angle) { return new Basis().set_axis_angle(axis, angle).xform(this); }
  move_toward(to, d) { const v = to.sub(this); const l = v.length(); return l <= d || l < CMP_EPSILON ? to.clone() : this.add(v.mul(d / l)); }
  limit_length(len = 1) { const l = this.length(); return l > 0 && len < l ? this.mul(len / l) : this.clone(); }
  abs() { return new Vector3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)); }
  floor() { return new Vector3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  round() { return new Vector3(Math.round(this.x), Math.round(this.y), Math.round(this.z)); }
  min(v) { return new Vector3(Math.min(this.x, v.x), Math.min(this.y, v.y), Math.min(this.z, v.z)); }
  max(v) { return new Vector3(Math.max(this.x, v.x), Math.max(this.y, v.y), Math.max(this.z, v.z)); }
  slide(n) { return this.sub(n.mul(this.dot(n))); }
  reflect(n) { return n.mul(2 * this.dot(n)).sub(this); }
  bounce(n) { return this.reflect(n).neg(); }
  project(b) { return b.mul(this.dot(b) / b.length_squared()); }
  is_equal_approx(v) { return MathUtil.is_equal_approx(this.x, v.x) && MathUtil.is_equal_approx(this.y, v.y) && MathUtil.is_equal_approx(this.z, v.z); }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
  toArray() { return [this.x, this.y, this.z]; }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
}

class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  clone() { return new Vector4(this.x, this.y, this.z, this.w); }
  add(v) { return new Vector4(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w); }
  sub(v) { return new Vector4(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w); }
  mul(s) { return typeof s === 'number' ? new Vector4(this.x * s, this.y * s, this.z * s, this.w * s) : new Vector4(this.x * s.x, this.y * s.y, this.z * s.z, this.w * s.w); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w; }
  length() { return Math.sqrt(this.dot(this)); }
  normalized() { const l = this.length(); return l === 0 ? new Vector4() : this.mul(1 / l); }
  lerp(v, t) { return new Vector4(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t, this.w + (v.w - this.w) * t); }
  is_equal_approx(v) { return MathUtil.is_equal_approx(this.x, v.x) && MathUtil.is_equal_approx(this.y, v.y) && MathUtil.is_equal_approx(this.z, v.z) && MathUtil.is_equal_approx(this.w, v.w); }
  toArray() { return [this.x, this.y, this.z, this.w]; }
  toString() { return `(${this.x}, ${this.y}, ${this.z}, ${this.w})`; }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  static get IDENTITY() { return new Quaternion(); }
  static from_axis_angle(axis, angle) {
    const d = axis.length(); if (d === 0) return new Quaternion();
    const s = Math.sin(angle * 0.5) / d;
    return new Quaternion(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle * 0.5));
  }
  static from_euler(e) { return new Basis().set_euler(e).get_rotation_quaternion(); }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w); }
  normalized() { const l = this.length(); return l === 0 ? new Quaternion() : new Quaternion(this.x / l, this.y / l, this.z / l, this.w / l); }
  is_normalized() { return MathUtil.is_equal_approx(this.length(), 1); }
  inverse() { return new Quaternion(-this.x, -this.y, -this.z, this.w); }
  dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
  mul(q) {
    const { x, y, z, w } = this;
    return new Quaternion(w * q.x + x * q.w + y * q.z - z * q.y, w * q.y + y * q.w + z * q.x - x * q.z, w * q.z + z * q.w + x * q.y - y * q.x, w * q.w - x * q.x - y * q.y - z * q.z);
  }
  // In-place: this = this * q (avoids allocation in the physics integrator).
  imul(q) {
    const { x, y, z, w } = this;
    this.x = w * q.x + x * q.w + y * q.z - z * q.y; this.y = w * q.y + y * q.w + z * q.x - x * q.z;
    this.z = w * q.z + z * q.w + x * q.y - y * q.x; this.w = w * q.w - x * q.x - y * q.y - z * q.z; return this;
  }
  inormalize() { const l = this.length(); if (l > 0) { this.x /= l; this.y /= l; this.z /= l; this.w /= l; } return this; }
  xform(v) {
    const ux = this.x, uy = this.y, uz = this.z, w = this.w;
    const cx = uy * v.z - uz * v.y, cy = uz * v.x - ux * v.z, cz = ux * v.y - uy * v.x;
    const ccx = uy * cz - uz * cy, ccy = uz * cx - ux * cz, ccz = ux * cy - uy * cx;
    return new Vector3(v.x + 2 * (w * cx + ccx), v.y + 2 * (w * cy + ccy), v.z + 2 * (w * cz + ccz));
  }
  get_angle() { return 2 * Math.acos(MathUtil.clamp(this.w, -1, 1)); }
  get_axis() { const r = 1 / Math.sqrt(Math.max(1e-12, 1 - this.w * this.w)); return new Vector3(this.x * r, this.y * r, this.z * r); }
  get_euler() { return new Basis().set_quaternion(this).get_euler(); }
  slerp(to, t) {
    let cos = this.dot(to); let tx = to.x, ty = to.y, tz = to.z, tw = to.w;
    if (cos < 0) { cos = -cos; tx = -tx; ty = -ty; tz = -tz; tw = -tw; }
    let s0, s1;
    if (1 - cos > CMP_EPSILON) { const om = Math.acos(cos), sn = Math.sin(om); s0 = Math.sin((1 - t) * om) / sn; s1 = Math.sin(t * om) / sn; }
    else { s0 = 1 - t; s1 = t; }
    return new Quaternion(s0 * this.x + s1 * tx, s0 * this.y + s1 * ty, s0 * this.z + s1 * tz, s0 * this.w + s1 * tw);
  }
  is_equal_approx(q) { return MathUtil.is_equal_approx(this.x, q.x) && MathUtil.is_equal_approx(this.y, q.y) && MathUtil.is_equal_approx(this.z, q.z) && MathUtil.is_equal_approx(this.w, q.w); }
  toArray() { return [this.x, this.y, this.z, this.w]; }
  toString() { return `(${this.x}, ${this.y}, ${this.z}, ${this.w})`; }
}

// Basis: 3x3 matrix stored as three column vectors x, y, z (Godot exposes columns as basis.x/y/z).
class Basis {
  constructor(x, y, z) {
    this.x = x ? x.clone() : new Vector3(1, 0, 0);
    this.y = y ? y.clone() : new Vector3(0, 1, 0);
    this.z = z ? z.clone() : new Vector3(0, 0, 1);
  }
  static get IDENTITY() { return new Basis(); }
  static from_euler(e, order = 2) { return new Basis().set_euler(e, order); }
  static from_scale(s) { return new Basis(new Vector3(s.x, 0, 0), new Vector3(0, s.y, 0), new Vector3(0, 0, s.z)); }
  static from_quaternion(q) { return new Basis().set_quaternion(q); }
  static from_axis_angle(axis, a) { return new Basis().set_axis_angle(axis, a); }
  // row r, column c
  el(r, c) { const col = c === 0 ? this.x : c === 1 ? this.y : this.z; return r === 0 ? col.x : r === 1 ? col.y : col.z; }
  set_rows(a, b, c, d, e, f, g, h, i) { // row-major args
    this.x.set(a, d, g); this.y.set(b, e, h); this.z.set(c, f, i); return this;
  }
  copy(b) { this.x.copy(b.x); this.y.copy(b.y); this.z.copy(b.z); return this; }
  clone() { return new Basis(this.x, this.y, this.z); }
  set_identity() { return this.set_rows(1, 0, 0, 0, 1, 0, 0, 0, 1); }
  set_axis_angle(axis, angle) {
    const a = axis.normalized(); const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return this.set_rows(
      t * a.x * a.x + c, t * a.x * a.y - s * a.z, t * a.x * a.z + s * a.y,
      t * a.x * a.y + s * a.z, t * a.y * a.y + c, t * a.y * a.z - s * a.x,
      t * a.x * a.z - s * a.y, t * a.y * a.z + s * a.x, t * a.z * a.z + c);
  }
  set_quaternion(q) {
    const d = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w; const s = 2 / d;
    const xs = q.x * s, ys = q.y * s, zs = q.z * s;
    const wx = q.w * xs, wy = q.w * ys, wz = q.w * zs, xx = q.x * xs, xy = q.x * ys, xz = q.x * zs;
    const yy = q.y * ys, yz = q.y * zs, zz = q.z * zs;
    return this.set_rows(1 - (yy + zz), xy - wz, xz + wy, xy + wz, 1 - (xx + zz), yz - wx, xz - wy, yz + wx, 1 - (xx + yy));
  }
  // order: EulerOrder; default 2 = EULER_ORDER_YXZ (Node3D default). Only YXZ and XYZ are implemented.
  set_euler(e, order = 2) {
    const cx = Math.cos(e.x), sx = Math.sin(e.x), cy = Math.cos(e.y), sy = Math.sin(e.y), cz = Math.cos(e.z), sz = Math.sin(e.z);
    const X = new Basis().set_rows(1, 0, 0, 0, cx, -sx, 0, sx, cx);
    const Y = new Basis().set_rows(cy, 0, sy, 0, 1, 0, -sy, 0, cy);
    const Z = new Basis().set_rows(cz, -sz, 0, sz, cz, 0, 0, 0, 1);
    if (order === 2) return this.copy(Y.mul(X).mul(Z));
    if (order === 0) return this.copy(X.mul(Y).mul(Z));
    throw new RangeError('Basis.set_euler: only EULER_ORDER_XYZ(0) and EULER_ORDER_YXZ(2) are supported');
  }
  // YXZ extraction, same branch structure as Godot's Basis::get_euler(EULER_ORDER_YXZ).
  get_euler(order = 2) {
    if (order !== 2) throw new RangeError('Basis.get_euler: only EULER_ORDER_YXZ(2) is supported');
    const m = (r, c) => this.el(r, c);
    const m12 = m(1, 2); const e = new Vector3();
    if (m12 < 1 - CMP_EPSILON) {
      if (m12 > -(1 - CMP_EPSILON)) {
        if (m(1, 0) === 0 && m(0, 1) === 0 && m(0, 2) === 0 && m(2, 0) === 0 && m(0, 0) === 1) {
          e.set(Math.atan2(-m12, m(1, 1)), 0, 0);
        } else {
          e.set(Math.asin(-m12), Math.atan2(m(0, 2), m(2, 2)), Math.atan2(m(1, 0), m(1, 1)));
        }
      } else e.set(Math.PI * 0.5, Math.atan2(m(0, 1), m(0, 0)), 0);
    } else e.set(-Math.PI * 0.5, -Math.atan2(m(0, 1), m(0, 0)), 0);
    return e;
  }
  mul(b) { // this * b
    return new Basis(this.xform(b.x), this.xform(b.y), this.xform(b.z));
  }
  xform(v) { return new Vector3(this.x.x * v.x + this.y.x * v.y + this.z.x * v.z, this.x.y * v.x + this.y.y * v.y + this.z.y * v.z, this.x.z * v.x + this.y.z * v.y + this.z.z * v.z); }
  xform_into(v, out) { const x = v.x, y = v.y, z = v.z; out.x = this.x.x * x + this.y.x * y + this.z.x * z; out.y = this.x.y * x + this.y.y * y + this.z.y * z; out.z = this.x.z * x + this.y.z * y + this.z.z * z; return out; }
  xform_inv(v) { return new Vector3(this.x.dot(v), this.y.dot(v), this.z.dot(v)); } // transpose * v
  xform_inv_into(v, out) { const x = this.x.dot(v), y = this.y.dot(v), z = this.z.dot(v); out.x = x; out.y = y; out.z = z; return out; }
  transposed() { return new Basis().set_rows(this.x.x, this.x.y, this.x.z, this.y.x, this.y.y, this.y.z, this.z.x, this.z.y, this.z.z); }
  determinant() { return this.x.dot(this.y.cross(this.z)); }
  inverse() {
    const a = this.el(0, 0), b = this.el(0, 1), c = this.el(0, 2), d = this.el(1, 0), e = this.el(1, 1), f = this.el(1, 2), g = this.el(2, 0), h = this.el(2, 1), i = this.el(2, 2);
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (det === 0) { Log.error('Basis.inverse: singular matrix'); return new Basis(); }
    const s = 1 / det;
    return new Basis().set_rows(A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s);
  }
  orthonormalized() {
    const x = this.x.normalized(); let y = this.y.sub(x.mul(x.dot(this.y))).normalized();
    const z = this.z.sub(x.mul(x.dot(this.z))).sub(y.mul(y.dot(this.z))).normalized();
    return new Basis(x, y, z);
  }
  get_scale() { const s = Math.sign(this.determinant()) || 1; return new Vector3(this.x.length(), this.y.length(), this.z.length()).mul(s); }
  scaled(s) { return Basis.from_scale(s).mul(this); } // global scale (rows), like Godot's Basis.scaled
  scaled_local(s) { return this.mul(Basis.from_scale(s)); }
  rotated(axis, angle) { return Basis.from_axis_angle(axis, angle).mul(this); }
  get_rotation_quaternion() {
    let m = this.orthonormalized(); if (m.determinant() < 0) m = m.scaled(new Vector3(-1, -1, -1));
    const t = m.el(0, 0) + m.el(1, 1) + m.el(2, 2);
    let q;
    if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = new Quaternion((m.el(2, 1) - m.el(1, 2)) / s, (m.el(0, 2) - m.el(2, 0)) / s, (m.el(1, 0) - m.el(0, 1)) / s, 0.25 * s); }
    else if (m.el(0, 0) > m.el(1, 1) && m.el(0, 0) > m.el(2, 2)) { const s = Math.sqrt(1 + m.el(0, 0) - m.el(1, 1) - m.el(2, 2)) * 2; q = new Quaternion(0.25 * s, (m.el(0, 1) + m.el(1, 0)) / s, (m.el(0, 2) + m.el(2, 0)) / s, (m.el(2, 1) - m.el(1, 2)) / s); }
    else if (m.el(1, 1) > m.el(2, 2)) { const s = Math.sqrt(1 + m.el(1, 1) - m.el(0, 0) - m.el(2, 2)) * 2; q = new Quaternion((m.el(0, 1) + m.el(1, 0)) / s, 0.25 * s, (m.el(1, 2) + m.el(2, 1)) / s, (m.el(0, 2) - m.el(2, 0)) / s); }
    else { const s = Math.sqrt(1 + m.el(2, 2) - m.el(0, 0) - m.el(1, 1)) * 2; q = new Quaternion((m.el(0, 2) + m.el(2, 0)) / s, (m.el(1, 2) + m.el(2, 1)) / s, 0.25 * s, (m.el(1, 0) - m.el(0, 1)) / s); }
    return q.normalized();
  }
  get_quaternion() { return this.get_rotation_quaternion(); }
  // Same construction as Godot's Basis::looking_at (-Z is forward unless use_model_front).
  static looking_at(target, up = Vector3.UP, use_model_front = false) {
    let vz = target.normalized(); if (!use_model_front) vz = vz.neg();
    let vx = up.cross(vz);
    if (vx.length_squared() < 1e-12) { Log.error('Basis.looking_at: target and up are colinear'); return new Basis(); }
    vx = vx.normalized(); const vy = vz.cross(vx);
    return new Basis(vx, vy, vz);
  }
  is_equal_approx(b) { return this.x.is_equal_approx(b.x) && this.y.is_equal_approx(b.y) && this.z.is_equal_approx(b.z); }
  toString() { return `[X: ${this.x}, Y: ${this.y}, Z: ${this.z}]`; }
}

class Transform3D {
  constructor(basis, origin) { this.basis = basis ? basis.clone() : new Basis(); this.origin = origin ? origin.clone() : new Vector3(); }
  static get IDENTITY() { return new Transform3D(); }
  copy(t) { this.basis.copy(t.basis); this.origin.copy(t.origin); return this; }
  clone() { return new Transform3D(this.basis, this.origin); }
  mul(t) { return new Transform3D(this.basis.mul(t.basis), this.xform(t.origin)); }
  // out = a * b, without allocating new transforms (out may alias neither a nor b).
  static mul_into(a, b, out) {
    a.basis.xform_into(b.basis.x, out.basis.x); a.basis.xform_into(b.basis.y, out.basis.y); a.basis.xform_into(b.basis.z, out.basis.z);
    a.basis.xform_into(b.origin, out.origin); out.origin.iadd(a.origin); return out;
  }
  xform(v) { return this.basis.xform(v).add(this.origin); }
  xform_into(v, out) { this.basis.xform_into(v, out); out.x += this.origin.x; out.y += this.origin.y; out.z += this.origin.z; return out; }
  xform_inv(v) { return this.basis.xform_inv(v.sub(this.origin)); } // assumes orthonormal basis
  affine_inverse() { const ib = this.basis.inverse(); return new Transform3D(ib, ib.xform(this.origin.neg())); }
  inverse() { const ib = this.basis.transposed(); return new Transform3D(ib, ib.xform(this.origin.neg())); }
  orthonormalized() { return new Transform3D(this.basis.orthonormalized(), this.origin); }
  translated(v) { return new Transform3D(this.basis, this.origin.add(v)); }
  translated_local(v) { return new Transform3D(this.basis, this.origin.add(this.basis.xform(v))); }
  rotated(axis, angle) { const r = Basis.from_axis_angle(axis, angle); return new Transform3D(r.mul(this.basis), r.xform(this.origin)); }
  rotated_local(axis, angle) { return new Transform3D(this.basis.mul(Basis.from_axis_angle(axis, angle)), this.origin); }
  scaled(s) { const S = Basis.from_scale(s); return new Transform3D(S.mul(this.basis), this.origin.mul(s)); }
  looking_at(target, up = Vector3.UP, use_model_front = false) { return new Transform3D(Basis.looking_at(target.sub(this.origin), up, use_model_front), this.origin); }
  interpolate_with(t, w) {
    const s1 = this.basis.get_scale(), s2 = t.basis.get_scale();
    const q = this.basis.get_rotation_quaternion().slerp(t.basis.get_rotation_quaternion(), w);
    return new Transform3D(Basis.from_quaternion(q).scaled_local(s1.lerp(s2, w)), this.origin.lerp(t.origin, w));
  }
  is_equal_approx(t) { return this.basis.is_equal_approx(t.basis) && this.origin.is_equal_approx(t.origin); }
  toString() { return `[X: ${this.basis.x}, Y: ${this.basis.y}, Z: ${this.basis.z}, O: ${this.origin}]`; }
}

class Transform2D {
  constructor(x, y, origin) { this.x = x ? x.clone() : new Vector2(1, 0); this.y = y ? y.clone() : new Vector2(0, 1); this.origin = origin ? origin.clone() : new Vector2(); }
  static get IDENTITY() { return new Transform2D(); }
  static from_rotation_position(rot, pos) { const c = Math.cos(rot), s = Math.sin(rot); return new Transform2D(new Vector2(c, s), new Vector2(-s, c), pos); }
  static from_components(rot, scale, pos) { const c = Math.cos(rot), s = Math.sin(rot); return new Transform2D(new Vector2(c * scale.x, s * scale.x), new Vector2(-s * scale.y, c * scale.y), pos); }
  copy(t) { this.x.copy(t.x); this.y.copy(t.y); this.origin.copy(t.origin); return this; }
  clone() { return new Transform2D(this.x, this.y, this.origin); }
  basis_xform(v) { return new Vector2(this.x.x * v.x + this.y.x * v.y, this.x.y * v.x + this.y.y * v.y); }
  xform(v) { return new Vector2(this.x.x * v.x + this.y.x * v.y + this.origin.x, this.x.y * v.x + this.y.y * v.y + this.origin.y); }
  mul(t) { return new Transform2D(this.basis_xform(t.x), this.basis_xform(t.y), this.xform(t.origin)); }
  static mul_into(a, b, out) {
    const bxx = b.x.x, bxy = b.x.y, byx = b.y.x, byy = b.y.y, box = b.origin.x, boy = b.origin.y;
    const ax = a.x.x, ay = a.x.y, cx = a.y.x, cy = a.y.y;
    out.x.set(ax * bxx + cx * bxy, ay * bxx + cy * bxy); out.y.set(ax * byx + cx * byy, ay * byx + cy * byy);
    out.origin.set(ax * box + cx * boy + a.origin.x, ay * box + cy * boy + a.origin.y); return out;
  }
  determinant() { return this.x.x * this.y.y - this.x.y * this.y.x; }
  affine_inverse() {
    const det = this.determinant(); if (det === 0) { Log.error('Transform2D.affine_inverse: singular'); return new Transform2D(); }
    const id = 1 / det;
    const nx = new Vector2(this.y.y * id, -this.x.y * id), ny = new Vector2(-this.y.x * id, this.x.x * id);
    const t = new Transform2D(nx, ny); t.origin = t.basis_xform(this.origin.neg()); return t;
  }
  get_rotation() { return Math.atan2(this.x.y, this.x.x); }
  get_scale() { const s = Math.sign(this.determinant()) || 1; return new Vector2(this.x.length(), s * this.y.length()); }
  get_origin() { return this.origin.clone(); }
  translated(v) { return new Transform2D(this.x, this.y, this.origin.add(v)); }
  rotated(a) { return Transform2D.from_rotation_position(a, new Vector2()).mul(this); }
  is_equal_approx(t) { return this.x.is_equal_approx(t.x) && this.y.is_equal_approx(t.y) && this.origin.is_equal_approx(t.origin); }
  toString() { return `[X: ${this.x}, Y: ${this.y}, O: ${this.origin}]`; }
}

class AABB {
  constructor(position, size) { this.position = position ? position.clone() : new Vector3(); this.size = size ? size.clone() : new Vector3(); }
  get end() { return this.position.add(this.size); }
  clone() { return new AABB(this.position, this.size); }
  copy(a) { this.position.copy(a.position); this.size.copy(a.size); return this; }
  get_center() { return this.position.add(this.size.mul(0.5)); }
  get_volume() { return this.size.x * this.size.y * this.size.z; }
  // Same strictness as Godot: touching faces do not intersect.
  intersects(b) {
    const a = this;
    if (a.position.x >= b.position.x + b.size.x) return false; if (a.position.x + a.size.x <= b.position.x) return false;
    if (a.position.y >= b.position.y + b.size.y) return false; if (a.position.y + a.size.y <= b.position.y) return false;
    if (a.position.z >= b.position.z + b.size.z) return false; if (a.position.z + a.size.z <= b.position.z) return false;
    return true;
  }
  encloses(b) {
    const ae = this.end, be = b.end;
    return this.position.x <= b.position.x && ae.x >= be.x && this.position.y <= b.position.y && ae.y >= be.y && this.position.z <= b.position.z && ae.z >= be.z;
  }
  has_point(p) {
    const e = this.end;
    return !(p.x < this.position.x || p.y < this.position.y || p.z < this.position.z || p.x > e.x || p.y > e.y || p.z > e.z);
  }
  merge(b) { const mn = this.position.min(b.position), mx = this.end.max(b.end); return new AABB(mn, mx.sub(mn)); }
  expand(p) { const mn = this.position.min(p), mx = this.end.max(p); return new AABB(mn, mx.sub(mn)); }
  grow(by) { return new AABB(this.position.sub(new Vector3(by, by, by)), this.size.add(new Vector3(by * 2, by * 2, by * 2))); }
  // Transform an AABB (Arvo's method), as Transform3D * AABB in Godot.
  xformed(t, out = new AABB()) {
    const min = [t.origin.x, t.origin.y, t.origin.z], max = [t.origin.x, t.origin.y, t.origin.z];
    const pmin = [this.position.x, this.position.y, this.position.z], pmax = [this.position.x + this.size.x, this.position.y + this.size.y, this.position.z + this.size.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const m = t.basis.el(i, j); const a = m * pmin[j], b = m * pmax[j];
      if (a < b) { min[i] += a; max[i] += b; } else { min[i] += b; max[i] += a; }
    }
    out.position.set(min[0], min[1], min[2]); out.size.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]); return out;
  }
  intersects_ray(from, dir) {
    let tmin = -Infinity, tmax = Infinity; const e = this.end;
    for (const ax of ['x', 'y', 'z']) {
      if (Math.abs(dir[ax]) < 1e-12) { if (from[ax] < this.position[ax] || from[ax] > e[ax]) return null; continue; }
      let t1 = (this.position[ax] - from[ax]) / dir[ax], t2 = (e[ax] - from[ax]) / dir[ax];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    return from.add(dir.mul(tmin >= 0 ? tmin : tmax));
  }
  is_equal_approx(b) { return this.position.is_equal_approx(b.position) && this.size.is_equal_approx(b.size); }
  toString() { return `[P: ${this.position}, S: ${this.size}]`; }
}

class Rect2 {
  constructor(x = 0, y = 0, w = 0, h = 0) {
    if (x instanceof Vector2) { this.position = x.clone(); this.size = y instanceof Vector2 ? y.clone() : new Vector2(); }
    else { this.position = new Vector2(x, y); this.size = new Vector2(w, h); }
  }
  get end() { return this.position.add(this.size); }
  clone() { return new Rect2(this.position, this.size); }
  get_center() { return this.position.add(this.size.mul(0.5)); }
  get_area() { return this.size.x * this.size.y; }
  // Godot: end edges are exclusive for has_point.
  has_point(p) { return !(p.x < this.position.x || p.y < this.position.y || p.x >= this.position.x + this.size.x || p.y >= this.position.y + this.size.y); }
  intersects(b, include_borders = false) {
    const a = this;
    if (include_borders) {
      return !(a.position.x > b.position.x + b.size.x || a.position.x + a.size.x < b.position.x || a.position.y > b.position.y + b.size.y || a.position.y + a.size.y < b.position.y);
    }
    return !(a.position.x >= b.position.x + b.size.x || a.position.x + a.size.x <= b.position.x || a.position.y >= b.position.y + b.size.y || a.position.y + a.size.y <= b.position.y);
  }
  encloses(b) { return b.position.x >= this.position.x && b.position.y >= this.position.y && b.position.x + b.size.x <= this.position.x + this.size.x && b.position.y + b.size.y <= this.position.y + this.size.y; }
  merge(b) { const x0 = Math.min(this.position.x, b.position.x), y0 = Math.min(this.position.y, b.position.y); const x1 = Math.max(this.end.x, b.end.x), y1 = Math.max(this.end.y, b.end.y); return new Rect2(x0, y0, x1 - x0, y1 - y0); }
  intersection(b) {
    if (!this.intersects(b)) return new Rect2();
    const x0 = Math.max(this.position.x, b.position.x), y0 = Math.max(this.position.y, b.position.y);
    const x1 = Math.min(this.end.x, b.end.x), y1 = Math.min(this.end.y, b.end.y); return new Rect2(x0, y0, x1 - x0, y1 - y0);
  }
  grow(by) { return new Rect2(this.position.x - by, this.position.y - by, this.size.x + by * 2, this.size.y + by * 2); }
  is_equal_approx(b) { return this.position.is_equal_approx(b.position) && this.size.is_equal_approx(b.size); }
  toString() { return `[P: ${this.position}, S: ${this.size}]`; }
}

class Color {
  constructor(r = 0, g = 0, b = 0, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }
  static html(str) {
    let s = String(str).trim(); if (s[0] === '#') s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) { Log.error('Color.html: invalid color', str); return new Color(); }
    const n = (i) => parseInt(s.substr(i, 2), 16) / 255;
    return new Color(n(0), n(2), n(4), s.length === 8 ? n(6) : 1);
  }
  static from_hsv(h, s, v, a = 1) {
    h = MathUtil.fposmod(h, 1) * 6; const i = Math.floor(h), f = h - i; const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const tab = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return new Color(tab[0], tab[1], tab[2], a);
  }
  static get WHITE() { return new Color(1, 1, 1, 1); } static get BLACK() { return new Color(0, 0, 0, 1); }
  static get TRANSPARENT() { return new Color(1, 1, 1, 0); } static get RED() { return new Color(1, 0, 0, 1); }
  static get GREEN() { return new Color(0, 1, 0, 1); } static get BLUE() { return new Color(0, 0, 1, 1); }
  set(r, g, b, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; this.a = c.a; return this; }
  clone() { return new Color(this.r, this.g, this.b, this.a); }
  mul(c) { return typeof c === 'number' ? new Color(this.r * c, this.g * c, this.b * c, this.a * c) : new Color(this.r * c.r, this.g * c.g, this.b * c.b, this.a * c.a); }
  add(c) { return new Color(this.r + c.r, this.g + c.g, this.b + c.b, this.a + c.a); }
  sub(c) { return new Color(this.r - c.r, this.g - c.g, this.b - c.b, this.a - c.a); }
  lerp(c, t) { return new Color(this.r + (c.r - this.r) * t, this.g + (c.g - this.g) * t, this.b + (c.b - this.b) * t, this.a + (c.a - this.a) * t); }
  srgb_to_linear() { const f = (c) => (c < 0.04045 ? c * (1 / 12.92) : Math.pow((c + 0.055) * (1 / 1.055), 2.4)); return new Color(f(this.r), f(this.g), f(this.b), this.a); }
  linear_to_srgb() { const f = (c) => (c < 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); return new Color(f(this.r), f(this.g), f(this.b), this.a); }
  get_luminance() { return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b; }
  inverted() { return new Color(1 - this.r, 1 - this.g, 1 - this.b, this.a); }
  to_html(with_alpha = true) { const h = (v) => Math.round(MathUtil.clamp(v, 0, 1) * 255).toString(16).padStart(2, '0'); return h(this.r) + h(this.g) + h(this.b) + (with_alpha ? h(this.a) : ''); }
  is_equal_approx(c) { return MathUtil.is_equal_approx(this.r, c.r) && MathUtil.is_equal_approx(this.g, c.g) && MathUtil.is_equal_approx(this.b, c.b) && MathUtil.is_equal_approx(this.a, c.a); }
  toArray() { return [this.r, this.g, this.b, this.a]; }
  toString() { return `(${this.r}, ${this.g}, ${this.b}, ${this.a})`; }
}

// Plane: normal · p = d (Godot convention; distance_to = normal·p - d).
class Plane {
  constructor(normal, d = 0) { this.normal = normal ? normal.clone() : new Vector3(0, 1, 0); this.d = d; }
  static from_points(a, b, c) { const n = a.sub(c).cross(a.sub(b)).normalized(); return new Plane(n, n.dot(a)); }
  static from_normal_point(n, p) { const nn = n.normalized(); return new Plane(nn, nn.dot(p)); }
  clone() { return new Plane(this.normal, this.d); }
  normalized() { const l = this.normal.length(); return l === 0 ? new Plane(new Vector3(), 0) : new Plane(this.normal.div(l), this.d / l); }
  distance_to(p) { return this.normal.dot(p) - this.d; }
  is_point_over(p) { return this.normal.dot(p) > this.d; }
  has_point(p, tol = CMP_EPSILON) { return Math.abs(this.distance_to(p)) <= tol; }
  project(p) { return p.sub(this.normal.mul(this.distance_to(p))); }
  get_center() { return this.normal.mul(this.d); }
  intersects_ray(from, dir) {
    const den = this.normal.dot(dir); if (MathUtil.is_zero_approx(den)) return null;
    const dist = (this.normal.dot(from) - this.d) / den; if (dist > CMP_EPSILON) return null; // behind ray
    return from.sub(dir.mul(dist));
  }
  intersects_segment(a, b) {
    const seg = b.sub(a); const den = this.normal.dot(seg); if (MathUtil.is_zero_approx(den)) return null;
    const dist = (this.normal.dot(a) - this.d) / den; if (dist < -CMP_EPSILON || dist > 1 + CMP_EPSILON) return null;
    return a.sub(seg.mul(dist));
  }
  is_equal_approx(p) { return this.normal.is_equal_approx(p.normal) && MathUtil.is_equal_approx(this.d, p.d); }
  toString() { return `[N: ${this.normal}, D: ${this.d}]`; }
}

// Column-major 4x4 helpers on Float32Array for GPU upload.
const Mat4 = {
  create() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  identity(m) { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  from_transform3d(t, m = new Float32Array(16)) {
    const b = t.basis;
    m[0] = b.x.x; m[1] = b.x.y; m[2] = b.x.z; m[3] = 0; m[4] = b.y.x; m[5] = b.y.y; m[6] = b.y.z; m[7] = 0;
    m[8] = b.z.x; m[9] = b.z.y; m[10] = b.z.z; m[11] = 0; m[12] = t.origin.x; m[13] = t.origin.y; m[14] = t.origin.z; m[15] = 1; return m;
  },
  // fovy in degrees (Godot Camera3D.fov is vertical with KEEP_HEIGHT).
  perspective(fovy_deg, aspect, near, far, m = new Float32Array(16)) {
    const f = 1 / Math.tan(MathUtil.deg_to_rad(fovy_deg) * 0.5); m.fill(0);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far); return m;
  },
  orthographic(l, r, b, t, n, f, m = new Float32Array(16)) {
    m.fill(0); m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1; return m;
  },
  multiply(a, b, out = new Float32Array(16)) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  },
  // Extract 6 frustum planes (inward-facing as Plane objects with Godot convention normal·p = d, inside: distance >= 0).
  frustum_planes(vp, out) {
    const rows = (i) => [vp[i], vp[4 + i], vp[8 + i], vp[12 + i]];
    const r0 = rows(0), r1 = rows(1), r2 = rows(2), r3 = rows(3);
    const defs = [[1, r0], [-1, r0], [1, r1], [-1, r1], [1, r2], [-1, r2]];
    for (let i = 0; i < 6; i++) {
      const s = defs[i][0], r = defs[i][1];
      const a = r3[0] + s * r[0], b = r3[1] + s * r[1], c = r3[2] + s * r[2], d = r3[3] + s * r[3];
      const l = Math.hypot(a, b, c);
      out[i].normal.set(a / l, b / l, c / l); out[i].d = -d / l;
    }
    return out;
  },
};

// §3 ─────────────────────────────────────────────────────────────────────────
const ObjectDB = {
  _next_id: 1,
  _live: new Map(), // id -> WeakRef(object)
  _class_counts: new Map(),
  _registry: typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry((info) => ObjectDB._collected(info)) : null,
  _register(obj) {
    const id = this._next_id++;
    this._live.set(id, new WeakRef(obj));
    const cls = obj.constructor._className || obj.constructor.name;
    this._class_counts.set(cls, (this._class_counts.get(cls) || 0) + 1);
    // GC-collected (never explicitly freed) objects are removed too; token lets free() unregister.
    if (this._registry) this._registry.register(obj, { id, cls }, obj);
    return id;
  },
  _unregister(obj) {
    if (!this._live.has(obj._id)) return;
    this._live.delete(obj._id);
    const cls = obj.constructor._className || obj.constructor.name;
    this._class_counts.set(cls, (this._class_counts.get(cls) || 1) - 1);
    if (this._registry) this._registry.unregister(obj);
  },
  _collected(info) {
    if (!this._live.has(info.id)) return;
    this._live.delete(info.id);
    this._class_counts.set(info.cls, (this._class_counts.get(info.cls) || 1) - 1);
  },
  get_object_count() { return this._live.size; },
  get_class_count(cls) { return this._class_counts.get(cls) || 0; },
  instance_from_id(id) { const r = this._live.get(id); return r ? r.deref() || null : null; },
};

// ClassDB: registry used by PackedScene/serialization. Properties are an explicit schema.
const ClassDB = {
  _classes: new Map(),
  register(ctor, name, properties = [], opts = {}) {
    ctor._className = name;
    const parent = Object.getPrototypeOf(ctor);
    this._classes.set(name, { ctor, name, properties, parent: parent && parent._className ? parent._className : null, abstract: !!opts.abstract });
    return ctor;
  },
  class_exists(name) { return this._classes.has(name); },
  get_parent_class(name) { const c = this._classes.get(name); return c ? c.parent : null; },
  instantiate(name) {
    const c = this._classes.get(name);
    if (!c) { Log.error('ClassDB.instantiate: unknown class', name); return null; }
    if (c.abstract) { Log.error('ClassDB.instantiate: class is abstract', name); return null; }
    return new c.ctor();
  },
  // All properties including inherited, base first.
  get_property_list(name) {
    const chain = []; let cur = name;
    while (cur) { const c = this._classes.get(cur); if (!c) break; chain.unshift(c); cur = c.parent; }
    const out = []; for (const c of chain) for (const p of c.properties) out.push(p);
    return out;
  },
  is_parent_class(name, parent) { let cur = name; while (cur) { if (cur === parent) return true; cur = this.get_parent_class(cur); } return false; },
};

const ConnectFlags = Object.freeze({ CONNECT_DEFERRED: 1, CONNECT_PERSIST: 2, CONNECT_ONE_SHOT: 4, CONNECT_REFERENCE_COUNTED: 8 });

class Callable {
  constructor(object, method, bound = null) {
    this.object = object || null; this.method = method; this.bound = bound;
    if (typeof method !== 'function' && typeof method !== 'string') throw new TypeError('Callable: method must be a function or method name');
  }
  static from(fn, object = null) { return fn instanceof Callable ? fn : new Callable(object, fn); }
  bind(...args) { return new Callable(this.object, this.method, (this.bound || []).concat(args)); }
  is_valid() {
    if (this.object && this.object._freed) return false;
    if (typeof this.method === 'string') return !!this.object && typeof this.object[this.method] === 'function';
    return true;
  }
  equals(o) { return o instanceof Callable && o.object === this.object && o.method === this.method && Callable._sameBound(this.bound, o.bound); }
  static _sameBound(a, b) { if (!a && !b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  call(...args) {
    if (this.bound) args = args.concat(this.bound);
    if (typeof this.method === 'string') {
      if (!this.object || this.object._freed) throw new Error(`Callable: target freed for method '${this.method}'`);
      const fn = this.object[this.method];
      if (typeof fn !== 'function') throw new Error(`Callable: method '${this.method}' not found on ${this.object.get_class ? this.object.get_class() : this.object}`);
      return fn.apply(this.object, args);
    }
    return this.method.apply(this.object, args);
  }
  call_deferred(...args) { MessageQueue.push_callable(this, args); }
  toString() { return `Callable(${this.object ? this.object.get_class() : 'null'}::${typeof this.method === 'string' ? this.method : this.method.name || '<fn>'})`; }
}

// Deferred call queue, flushed by the SceneTree at defined points of the frame.
const MessageQueue = {
  _q: [], _flushing: false, max_iterations: 100000,
  push_callable(c, args) { this._q.push(c, args); },
  get size() { return this._q.length / 2; },
  flush() {
    if (this._flushing) return;
    this._flushing = true;
    let i = 0, n = 0;
    try {
      while (i < this._q.length) {
        const c = this._q[i], a = this._q[i + 1]; i += 2;
        if (++n > this.max_iterations) { Log.error('MessageQueue: too many deferred calls in one flush (possible infinite recursion); dropping remainder'); break; }
        if (c.object && c.object._freed) continue;
        try { c.call(...a); } catch (e) { Log.error('Error in deferred call', c.toString(), e); }
      }
    } finally { this._q.length = 0; this._flushing = false; }
  },
  clear() { this._q.length = 0; },
};

// Holder of a signal reference, as returned by obj.signal('name').
class Signal {
  constructor(object, name) { this.object = object; this.name = name; }
  connect(c, flags = 0) { return this.object.connect(this.name, c, flags); }
  disconnect(c) { return this.object.disconnect(this.name, c); }
  is_connected(c) { return this.object.is_connected(this.name, c); }
  emit(...a) { return this.object.emit_signal(this.name, ...a); }
  get_connections() { return this.object.get_signal_connection_list(this.name); }
  // Promise resolving with the emitted args (single arg unwrapped), similar to `await signal`.
  wait() { return new Promise((res) => this.object.connect(this.name, (...a) => res(a.length <= 1 ? a[0] : a), ConnectFlags.CONNECT_ONE_SHOT)); }
}

const NOTIFICATION_POSTINITIALIZE = 0, NOTIFICATION_PREDELETE = 1;
let _signalConnCount = 0;

class GObject {
  constructor() {
    this._id = ObjectDB._register(this);
    this._freed = false;
    this._signals = null;   // Map<name, Conn[]>
    this._inbound = null;   // Set<Conn> where this object is the callable target
    this._user_signals = null;
    this._meta = null;
  }
  static _declared_signals(ctor) {
    if (Object.prototype.hasOwnProperty.call(ctor, '_sigcache')) return ctor._sigcache;
    const set = new Set(); let c = ctor;
    while (c && c !== Function.prototype) { if (Object.prototype.hasOwnProperty.call(c, 'signals')) for (const s of c.signals) set.add(s); c = Object.getPrototypeOf(c); }
    ctor._sigcache = set; return set;
  }
  get_instance_id() { return this._id; }
  get_class() { return this.constructor._className || this.constructor.name; }
  is_class(name) { let c = this.constructor; while (c && c !== Function.prototype) { if ((c._className || c.name) === name) return true; c = Object.getPrototypeOf(c); } return false; }
  is_freed() { return this._freed; }
  // Engine-side handling runs first, user _notification after; PREDELETE is reversed (user first), as in Godot.
  notification(what) {
    if (what === NOTIFICATION_PREDELETE) { this._user_notification(what); this._internal_notification(what); }
    else { this._internal_notification(what); this._user_notification(what); }
  }
  _internal_notification(what) {}
  _user_notification(what) {
    if (typeof this._notification !== 'function') return;
    try { this._notification(what); } catch (e) { Log.error(`Error in ${this.get_class()}._notification(${what}):`, e); }
  }
  // ── signals
  add_user_signal(name) { (this._user_signals || (this._user_signals = new Set())).add(name); }
  has_signal(name) { return GObject._declared_signals(this.constructor).has(name) || (!!this._user_signals && this._user_signals.has(name)); }
  signal(name) { if (!this.has_signal(name)) Log.error(`Signal '${name}' does not exist on ${this.get_class()}`); return new Signal(this, name); }
  get_signal_list() { const out = [...GObject._declared_signals(this.constructor)]; if (this._user_signals) out.push(...this._user_signals); return out; }
  connect(name, callable, flags = 0) {
    if (this._freed) { Log.error('connect: object is freed'); return Err.ERR_INVALID_PARAMETER; }
    if (!this.has_signal(name)) { Log.error(`connect: signal '${name}' does not exist on ${this.get_class()}`); return Err.ERR_INVALID_PARAMETER; }
    const c = Callable.from(callable);
    if (c.object && c.object._freed) { Log.error('connect: target object is freed'); return Err.ERR_INVALID_PARAMETER; }
    if (!this._signals) this._signals = new Map();
    let list = this._signals.get(name); if (!list) { list = []; this._signals.set(name, list); }
    for (const conn of list) {
      if (conn.callable.equals(c)) {
        if (flags & ConnectFlags.CONNECT_REFERENCE_COUNTED) { conn.refs++; return Err.OK; }
        Log.error(`connect: signal '${name}' is already connected to ${c}`); return Err.ERR_INVALID_PARAMETER;
      }
    }
    const conn = { source: this, signal: name, callable: c, flags, refs: 1, dead: false };
    list.push(conn); _signalConnCount++;
    if (c.object instanceof GObject) (c.object._inbound || (c.object._inbound = new Set())).add(conn);
    return Err.OK;
  }
  _remove_conn(conn) {
    if (conn.dead) return; conn.dead = true; _signalConnCount--;
    const list = this._signals && this._signals.get(conn.signal);
    if (list) { const i = list.indexOf(conn); if (i >= 0) list.splice(i, 1); if (!list.length) this._signals.delete(conn.signal); }
    const t = conn.callable.object; if (t && t._inbound) t._inbound.delete(conn);
  }
  disconnect(name, callable) {
    const c = Callable.from(callable);
    const list = this._signals && this._signals.get(name);
    const conn = list && list.find((x) => x.callable.equals(c));
    if (!conn) { Log.error(`disconnect: '${name}' is not connected to ${c}`); return; }
    if ((conn.flags & ConnectFlags.CONNECT_REFERENCE_COUNTED) && --conn.refs > 0) return;
    this._remove_conn(conn);
  }
  is_connected(name, callable) {
    const c = Callable.from(callable); const list = this._signals && this._signals.get(name);
    return !!list && list.some((x) => x.callable.equals(c));
  }
  get_signal_connection_list(name) {
    const list = this._signals && this._signals.get(name);
    return list ? list.map((x) => ({ signal: new Signal(this, name), callable: x.callable, flags: x.flags })) : [];
  }
  get_incoming_connections() { return this._inbound ? [...this._inbound].map((x) => ({ signal: new Signal(x.source, x.signal), callable: x.callable, flags: x.flags })) : []; }
  // Each listener runs isolated: an exception is logged and the remaining listeners still run.
  emit_signal(name, ...args) {
    if (this._freed) return Err.ERR_UNAVAILABLE;
    if (Config.debug && !this.has_signal(name)) { Log.error(`emit_signal: signal '${name}' does not exist on ${this.get_class()}`); return Err.ERR_UNAVAILABLE; }
    const list = this._signals && this._signals.get(name);
    if (!list || !list.length) return Err.OK;
    const snapshot = list.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const conn = snapshot[i];
      if (conn.dead) continue;
      const tgt = conn.callable.object;
      if (tgt && tgt._freed) { this._remove_conn(conn); continue; }
      if (conn.flags & ConnectFlags.CONNECT_ONE_SHOT) this._remove_conn(conn);
      if (conn.flags & ConnectFlags.CONNECT_DEFERRED) { MessageQueue.push_callable(conn.callable, args); continue; }
      try { conn.callable.call(...args); }
      catch (e) { Log.error(`Error in signal '${name}' handler ${conn.callable} on ${this.get_class()}:`, e); }
      if (this._freed) break;
    }
    return Err.OK;
  }
  _disconnect_all() {
    if (this._signals) { for (const list of [...this._signals.values()]) for (const conn of list.slice()) this._remove_conn(conn); this._signals = null; }
    if (this._inbound) { for (const conn of [...this._inbound]) conn.source._remove_conn(conn); this._inbound = null; }
  }
  // ── deferred / meta
  call_deferred(method, ...args) { MessageQueue.push_callable(new Callable(this, method), args); }
  set_deferred(prop, value) { MessageQueue.push_callable(new Callable(this, function () { this[prop] = value; }), []); }
  set_meta(k, v) { (this._meta || (this._meta = new Map())).set(k, v); }
  get_meta(k, def = null) { return this._meta && this._meta.has(k) ? this._meta.get(k) : def; }
  has_meta(k) { return !!this._meta && this._meta.has(k); }
  remove_meta(k) { if (this._meta) this._meta.delete(k); }
  free() {
    if (this._freed) { Log.error(`free: ${this.get_class()} #${this._id} already freed`); return; }
    this.notification(NOTIFICATION_PREDELETE);
    this._disconnect_all();
    this._freed = true;
    ObjectDB._unregister(this);
  }
  toString() { return `<${this.get_class()}#${this._id}>`; }
}
GObject.signals = [];
ClassDB.register(GObject, 'Object', [], { abstract: false });
const is_instance_valid = (o) => !!o && o instanceof GObject && !o._freed;

// Resource: shared data with an explicit dispose() for any browser/GPU resource it owns.
const _resourceCounts = new Map();
class Resource extends GObject {
  constructor() {
    super();
    this.resource_name = ''; this.resource_path = ''; this.resource_local_to_scene = false;
    const c = this.get_class(); _resourceCounts.set(c, (_resourceCounts.get(c) || 0) + 1);
  }
  emit_changed() { this.emit_signal('changed'); }
  // Release owned browser resources; override in subclasses and call super.
  dispose() {
    if (this._freed) return;
    const c = this.get_class(); _resourceCounts.set(c, (_resourceCounts.get(c) || 1) - 1);
    GObject.prototype.free.call(this);
  }
  free() { this.dispose(); }
  duplicate(deep = false) {
    const copy = ClassDB.instantiate(this.get_class());
    for (const p of ClassDB.get_property_list(this.get_class())) {
      let v = this[p.name];
      if (v instanceof Resource) v = deep ? v.duplicate(true) : v;
      else if (v && typeof v.clone === 'function') v = v.clone();
      else if (Array.isArray(v)) v = v.slice();
      copy[p.name] = v;
    }
    return copy;
  }
}
Resource.signals = ['changed'];
ClassDB.register(Resource, 'Resource', [
  { name: 'resource_name', type: 'string' }, { name: 'resource_path', type: 'string' },
]);
const ResourceStats = { counts: () => Object.fromEntries(_resourceCounts), count: (c) => _resourceCounts.get(c) || 0 };

// §4 ─────────────────────────────────────────────────────────────────────────
// Iteration order mirrors Godot's Main::iteration: N fixed physics steps first, then one process step, then draw.
const Engine = {
  physics_ticks_per_second: 60,
  max_physics_steps_per_frame: 8,
  time_scale: 1.0,
  max_fps: 0,
  // Real-time delta clamp: after tab suspension rAF can report seconds of delta; clamp to avoid a spiral.
  max_frame_delta: 0.25,
  _main_loop: null, _running: false, _paused: false, _raf: 0, _last: -1, _accum: 0,
  _frames_drawn: 0, _process_frames: 0, _physics_frames: 0, _in_physics: false,
  _fps_frames: 0, _fps_time: 0, _fps: 0, _real_time: 0,
  _visHandler: null, _suspended_hidden: false,
  last_frame_clamped: false,
  get_main_loop() { return this._main_loop; },
  set_main_loop(ml) { this._main_loop = ml; },
  get_frames_drawn() { return this._frames_drawn; },
  get_process_frames() { return this._process_frames; },
  get_physics_frames() { return this._physics_frames; },
  get_frames_per_second() { return this._fps; },
  is_in_physics_frame() { return this._in_physics; },
  get_physics_interpolation_fraction() { return this._accum * this.physics_ticks_per_second; },
  get_version_info() { return { major: 0, minor: 1, patch: 0, string: VERSION, godot_reference: GODOT_REFERENCE_VERSION }; },
  is_running() { return this._running && !this._paused; },
  start() {
    if (this._running) return;
    if (typeof requestAnimationFrame !== 'function') throw new Error('Engine.start requires requestAnimationFrame');
    this._running = true; this._paused = false; this._last = -1;
    if (typeof document !== 'undefined' && !this._visHandler) {
      this._visHandler = () => { if (document.hidden) this._suspended_hidden = true; else { this._last = -1; this._suspended_hidden = false; } };
      document.addEventListener('visibilitychange', this._visHandler);
    }
    const tick = (ts) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(tick);
      if (this._paused || this._suspended_hidden) { this._last = ts; return; }
      if (this._last < 0) { this._last = ts; return; }
      let dt = (ts - this._last) / 1000;
      if (this.max_fps > 0 && dt < 1 / this.max_fps - 0.001) return;
      this._last = ts;
      this.iteration(dt);
    };
    this._raf = requestAnimationFrame(tick);
  },
  stop() {
    this._running = false; if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
    if (this._visHandler) { document.removeEventListener('visibilitychange', this._visHandler); this._visHandler = null; }
  },
  pause() { this._paused = true; },
  resume() { this._paused = false; this._last = -1; },
  // One engine iteration with a real-time delta in seconds. Public so tests and custom loops can drive it deterministically.
  iteration(real_dt) {
    this.last_frame_clamped = false;
    if (!(real_dt >= 0)) real_dt = 0;
    if (real_dt > this.max_frame_delta) { real_dt = this.max_frame_delta; this.last_frame_clamped = true; }
    this._real_time += real_dt;
    this._fps_frames++; this._fps_time += real_dt;
    if (this._fps_time >= 1) { this._fps = this._fps_frames / this._fps_time; this._fps_frames = 0; this._fps_time = 0; }
    const ml = this._main_loop;
    const step = 1 / this.physics_ticks_per_second;
    this._accum += real_dt;
    let steps = 0;
    const t0 = now();
    while (this._accum >= step - 1e-9 && steps < this.max_physics_steps_per_frame) {
      this._accum -= step; steps++;
      this._in_physics = true;
      try { if (ml) ml._physics_step(step * this.time_scale, step); }
      catch (e) { Log.error('Uncaught error in physics step', e); }
      finally { this._in_physics = false; }
      this._physics_frames++;
    }
    // Drop backlog that could not be simulated this frame (Godot also caps at max_physics_steps_per_frame).
    if (steps >= this.max_physics_steps_per_frame && this._accum > step) this._accum = this._accum % step;
    const t1 = now();
    try { if (ml) ml._process_step(real_dt * this.time_scale, real_dt); }
    catch (e) { Log.error('Uncaught error in process step', e); }
    this._process_frames++;
    const t2 = now();
    try { if (ml && ml._draw) { if (ml._draw()) this._frames_drawn++; } }
    catch (e) { Log.error('Uncaught error in draw', e); }
    const t3 = now();
    Performance._record(t3 - t0, t1 - t0, t2 - t1, t3 - t2, steps);
    return steps;
  },
};

// Performance monitors (subset of Godot's Performance singleton plus engine-specific counters).
const Performance = {
  TIME_FPS: 'time/fps', TIME_PROCESS: 'time/process', TIME_PHYSICS_PROCESS: 'time/physics_process',
  TIME_RENDER: 'time/render', TIME_FRAME: 'time/frame', OBJECT_COUNT: 'object/objects', OBJECT_NODE_COUNT: 'object/nodes',
  OBJECT_RESOURCE_COUNT: 'object/resources', RENDER_TOTAL_DRAW_CALLS_IN_FRAME: 'render/draw_calls',
  RENDER_TOTAL_OBJECTS_IN_FRAME: 'render/objects', RENDER_TOTAL_PRIMITIVES_IN_FRAME: 'render/primitives',
  RENDER_TEXTURE_MEM_USED: 'render/texture_mem', RENDER_BUFFER_MEM_USED: 'render/buffer_mem',
  PHYSICS_3D_ACTIVE_OBJECTS: 'physics_3d/active_objects', PHYSICS_3D_COLLISION_PAIRS: 'physics_3d/collision_pairs',
  _last: { frame: 0, physics: 0, process: 0, render: 0, steps: 0 },
  _avg: { frame: 0, physics: 0, process: 0, render: 0 },
  _custom: new Map(),
  _providers: [],
  _record(frame, physics, process, render, steps) {
    const L = this._last; L.frame = frame; L.physics = physics; L.process = process; L.render = render; L.steps = steps;
    const a = 0.1, A = this._avg;
    A.frame += (frame - A.frame) * a; A.physics += (physics - A.physics) * a; A.process += (process - A.process) * a; A.render += (render - A.render) * a;
  },
  add_custom_monitor(id, fn) { this._custom.set(id, fn); },
  remove_custom_monitor(id) { this._custom.delete(id); },
  get_monitor(id) {
    switch (id) {
      case this.TIME_FPS: return Engine.get_frames_per_second();
      case this.TIME_FRAME: return this._last.frame / 1000;
      case this.TIME_PROCESS: return this._last.process / 1000;
      case this.TIME_PHYSICS_PROCESS: return this._last.physics / 1000;
      case this.TIME_RENDER: return this._last.render / 1000;
      case this.OBJECT_COUNT: return ObjectDB.get_object_count();
    }
    for (const p of this._providers) { const v = p(id); if (v !== undefined) return v; }
    const c = this._custom.get(id); if (c) return c();
    Log.error('Performance.get_monitor: unknown monitor', id); return 0;
  },
  snapshot() {
    const out = {};
    for (const k of Object.keys(this)) { if (/^[A-Z_0-9]+$/.test(k)) out[this[k]] = this.get_monitor(this[k]); }
    for (const [k, f] of this._custom) out[k] = f();
    out['avg/frame_ms'] = this._avg.frame; out['avg/physics_ms'] = this._avg.physics; out['avg/process_ms'] = this._avg.process; out['avg/render_ms'] = this._avg.render;
    return out;
  },
};

// §5 ─────────────────────────────────────────────────────────────────────────
class NodePath {
  constructor(path = '') {
    if (path instanceof NodePath) path = path.toString();
    this._str = String(path);
    let p = this._str; let sub = [];
    const ci = p.indexOf(':');
    if (ci >= 0) { sub = p.slice(ci + 1).split(':').filter((s) => s.length); p = p.slice(0, ci); }
    this.absolute = p.startsWith('/');
    this.names = p.split('/').filter((s) => s.length);
    this.subnames = sub;
  }
  is_absolute() { return this.absolute; }
  is_empty() { return this.names.length === 0 && this.subnames.length === 0; }
  get_name_count() { return this.names.length; }
  get_name(i) { return this.names[i]; }
  get_subname_count() { return this.subnames.length; }
  get_subname(i) { return this.subnames[i]; }
  get_concatenated_names() { return (this.absolute ? '/' : '') + this.names.join('/'); }
  get_concatenated_subnames() { return this.subnames.join(':'); }
  toString() { return this._str; }
  equals(o) { return String(o) === this._str; }
}

const NOTIFICATION = Object.freeze({
  POSTINITIALIZE: 0, PREDELETE: 1, ENTER_TREE: 10, EXIT_TREE: 11, READY: 13, PAUSED: 14, UNPAUSED: 15,
  PHYSICS_PROCESS: 16, PROCESS: 17, PARENTED: 18, UNPARENTED: 19, SCENE_INSTANTIATED: 20, PATH_RENAMED: 23,
  CHILD_ORDER_CHANGED: 24, INTERNAL_PROCESS: 25, INTERNAL_PHYSICS_PROCESS: 26, POST_ENTER_TREE: 27,
  TRANSFORM_CHANGED: 2000, VISIBILITY_CHANGED: 43,
});
const ProcessMode = Object.freeze({ PROCESS_MODE_INHERIT: 0, PROCESS_MODE_PAUSABLE: 1, PROCESS_MODE_WHEN_PAUSED: 2, PROCESS_MODE_ALWAYS: 3, PROCESS_MODE_DISABLED: 4 });
const _INVALID_NAME_CHARS = /[.:@/"%]/g;
let _nodeNameCounter = 0;
let _nodeLiveCount = 0;
const _globalDeleteQueue = [];

const _wildcard = (pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

class Node extends GObject {
  constructor(name) {
    super();
    _nodeLiveCount++;
    this._name = name ? String(name).replace(_INVALID_NAME_CHARS, '') : (this.constructor._className || this.constructor.name);
    this._parent = null; this._children = []; this._tree = null; this._depth = -1;
    this._ready_first = true; this._ready_notified = false; this._blocked = 0;
    this._groups = null; // Map<name, persistent>
    this._owner = null; this.unique_name_in_owner = false; this.scene_file_path = '';
    this._process_mode = ProcessMode.PROCESS_MODE_INHERIT; this._process_priority = 0; this._process_physics_priority = 0;
    this._proc = false; this._phys = false; this._proc_int = false; this._phys_int = false;
    this._input_enabled = false; this._unhandled = false;
    this._queued = false; this._tweens = null; this._tree_index = 0;
    this.editor_description = '';
  }
  // ── naming
  get name() { return this._name; }
  set name(v) {
    v = String(v).replace(_INVALID_NAME_CHARS, '');
    if (!v.length) { Log.error('Node name cannot be empty'); return; }
    if (v === this._name) return;
    this._name = v;
    if (this._parent) this._parent._validate_child_name(this, true);
    if (this._tree) { this.emit_signal('renamed'); this._tree.emit_signal('node_renamed', this); this._tree._tree_changed(); }
  }
  _validate_child_name(child, readable) {
    const clash = () => this._children.some((c) => c !== child && c._name === child._name);
    if (!clash()) return;
    if (readable) {
      const m = /^(.*?)(\d*)$/.exec(child._name); const base = m[1]; let n = m[2] ? parseInt(m[2], 10) : 1;
      do { n++; child._name = base + n; } while (clash());
    } else {
      const base = child._name; do { child._name = '@' + base + '@' + (++_nodeNameCounter); } while (clash());
    }
  }
  get_name() { return this._name; }
  set_name(v) { this.name = v; }
  // ── hierarchy
  get owner() { return this._owner; }
  set owner(o) {
    if (o && (o === this || !o.is_ancestor_of(this))) { Log.error('Invalid owner: owner must be an ancestor of the node'); return; }
    this._owner = o || null;
  }
  get_parent() { return this._parent; }
  get_tree() { return this._tree; }
  is_inside_tree() { return !!this._tree; }
  is_node_ready() { return !this._ready_first; }
  get_child_count() { return this._children.length; }
  get_children() { return this._children.slice(); }
  get_child(i) { if (i < 0) i += this._children.length; const c = this._children[i]; if (!c) Log.error('get_child: index out of bounds', i); return c || null; }
  get_index() { return this._parent ? this._parent._children.indexOf(this) : -1; }
  is_ancestor_of(n) { let p = n ? n._parent : null; while (p) { if (p === this) return true; p = p._parent; } return false; }
  add_child(node, force_readable_name = false) {
    if (!(node instanceof Node)) { Log.error('add_child: argument is not a Node'); return; }
    if (node._freed || this._freed) { Log.error('add_child: node is freed'); return; }
    if (node === this) { Log.error("add_child: can't add a node as child of itself"); return; }
    if (node._parent) { Log.error(`add_child: can't add child '${node._name}' to '${this._name}', already has a parent '${node._parent._name}'`); return; }
    if (node.is_ancestor_of(this)) { Log.error("add_child: can't add an ancestor as a child"); return; }
    if (this._blocked > 0) { Log.error("Parent node is busy setting up children, add_child() failed. Consider using add_child.call_deferred(child) instead."); return; }
    this._validate_child_name(node, force_readable_name);
    this._children.push(node);
    node._parent = node._parent || this;
    node.notification(NOTIFICATION.PARENTED);
    if (this._tree) node._set_tree(this._tree);
    this.notification(NOTIFICATION.CHILD_ORDER_CHANGED);
    this.emit_signal('child_order_changed');
  }
  add_sibling(node, force_readable_name = false) {
    if (!this._parent) { Log.error('add_sibling: node has no parent'); return; }
    this._parent.add_child(node, force_readable_name); this._parent.move_child(node, this.get_index() + 1);
  }
  remove_child(node) {
    if (!node || node._parent !== this) { Log.error('remove_child: node is not a child of this node'); return; }
    if (this._blocked > 0) { Log.error('Parent node is busy adding/removing children, remove_child() failed. Consider using remove_child.call_deferred(child) instead.'); return; }
    if (node._tree) node._set_tree(null);
    const i = this._children.indexOf(node); if (i >= 0) this._children.splice(i, 1);
    node.notification(NOTIFICATION.UNPARENTED);
    node._parent = null;
    node._propagate_validate_owner();
    this.notification(NOTIFICATION.CHILD_ORDER_CHANGED);
    this.emit_signal('child_order_changed');
  }
  _propagate_validate_owner() {
    if (this._owner && !this._owner.is_ancestor_of(this)) this._owner = null;
    for (const c of this._children) c._propagate_validate_owner();
  }
  move_child(child, to) {
    if (child._parent !== this) { Log.error('move_child: not a child'); return; }
    const n = this._children.length; if (to < 0) to += n; to = MathUtil.clamp(to, 0, n - 1);
    const i = this._children.indexOf(child); if (i === to) return;
    this._children.splice(i, 1); this._children.splice(to, 0, child);
    if (this._tree) this._tree._tree_changed();
    this.notification(NOTIFICATION.CHILD_ORDER_CHANGED); this.emit_signal('child_order_changed');
  }
  reparent(new_parent, keep_global_transform = true) {
    if (!this._parent) { Log.error('reparent: node has no parent'); return; }
    if (new_parent === this._parent) return;
    let g = null;
    if (keep_global_transform && this._capture_global_for_reparent) g = this._capture_global_for_reparent();
    const ownerKeep = this._owner;
    this._parent.remove_child(this);
    new_parent.add_child(this);
    if (ownerKeep && ownerKeep.is_ancestor_of(this)) this._owner = ownerKeep;
    if (g && this._restore_global_after_reparent) this._restore_global_after_reparent(g);
  }
  replace_by(node, keep_groups = false) {
    const parent = this._parent; if (!parent) { Log.error('replace_by: node has no parent'); return; }
    const idx = this.get_index();
    if (keep_groups && this._groups) for (const [g, p] of this._groups) node.add_to_group(g, p);
    const kids = this._children.slice();
    parent.remove_child(this);
    parent.add_child(node); parent.move_child(node, idx);
    this.emit_signal('replacing_by', node);
    for (const k of kids) { this.remove_child(k); node.add_child(k); }
    node._name = this._name; parent._validate_child_name(node, true);
  }
  _set_tree(tree) {
    let tree_changed_a = null, tree_changed_b = null;
    if (this._tree) { this._propagate_exit_tree(tree_changed_a = this._tree); }
    this._tree = tree;
    if (this._tree) {
      this._propagate_enter_tree();
      if (!this._parent || this._parent._ready_notified) this._propagate_ready();
      tree_changed_b = this._tree;
    }
    if (tree_changed_a) { this._propagate_after_exit_tree(); tree_changed_a._tree_changed(); }
    if (tree_changed_b) tree_changed_b._tree_changed();
  }
  _propagate_enter_tree() {
    if (this._parent) { this._tree = this._parent._tree; this._depth = this._parent._depth + 1; }
    else this._depth = 1;
    const tree = this._tree;
    tree._node_count++;
    tree._proc_dirty = true;
    if (this._groups) for (const g of this._groups.keys()) tree._add_to_group(g, this);
    this._on_enter_tree_internal();
    this.notification(NOTIFICATION.ENTER_TREE);
    if (this._enter_tree) this._safe_call('_enter_tree');
    this.emit_signal('tree_entered');
    tree.emit_signal('node_added', this);
    if (this._parent) this._parent.emit_signal('child_entered_tree', this);
    this._blocked++;
    for (let i = 0; i < this._children.length; i++) { const c = this._children[i]; if (!c._tree) c._propagate_enter_tree(); }
    this._blocked--;
  }
  _propagate_ready() {
    this._ready_notified = true;
    this._blocked++;
    for (let i = 0; i < this._children.length; i++) this._children[i]._propagate_ready();
    this._blocked--;
    this.notification(NOTIFICATION.POST_ENTER_TREE);
    if (this._ready_first) {
      this._ready_first = false;
      // Same as Godot: overriding _process/_physics_process/_input/_unhandled_input auto-enables processing at READY.
      if (typeof this._process === 'function') this.set_process(true);
      if (typeof this._physics_process === 'function') this.set_physics_process(true);
      if (typeof this._input === 'function') this.set_process_input(true);
      if (typeof this._unhandled_input === 'function') this.set_process_unhandled_input(true);
      this.notification(NOTIFICATION.READY);
      if (this._ready) this._safe_call('_ready');
      this.emit_signal('ready');
    }
  }
  _propagate_exit_tree() {
    this._blocked++;
    for (let i = this._children.length - 1; i >= 0; i--) this._children[i]._propagate_exit_tree();
    this._blocked--;
    if (this._exit_tree) this._safe_call('_exit_tree');
    this.emit_signal('tree_exiting');
    this.notification(NOTIFICATION.EXIT_TREE);
    this._on_exit_tree_internal();
    const tree = this._tree;
    tree.emit_signal('node_removed', this);
    if (this._parent) this._parent.emit_signal('child_exiting_tree', this);
    if (this._groups) for (const g of this._groups.keys()) tree._remove_from_group(g, this);
    tree._node_count--; tree._proc_dirty = true;
    if (tree.current_scene === this) tree.current_scene = null;
    this._ready_notified = false;
    this._tree = null; this._depth = -1;
  }
  _propagate_after_exit_tree() {
    this._blocked++;
    for (let i = this._children.length - 1; i >= 0; i--) this._children[i]._propagate_after_exit_tree();
    this._blocked--;
    this.emit_signal('tree_exited');
  }
  // Hooks for subclasses (rendering/physics registration) — not user virtuals.
  _on_enter_tree_internal() {}
  _on_exit_tree_internal() {}
  _safe_call(method, ...args) {
    try { return this[method](...args); }
    catch (e) { Log.error(`Error in ${this.get_class()}('${this._name}').${method}:`, e); return undefined; }
  }
  request_ready() { this._ready_first = true; }
  // ── paths
  get_path() {
    if (!this._tree) { Log.error('get_path: node is not inside the tree'); return new NodePath(''); }
    const parts = []; let n = this; while (n) { parts.unshift(n._name); n = n._parent; }
    return new NodePath('/' + parts.join('/'));
  }
  get_path_to(node) {
    const mine = []; let a = this; while (a) { mine.push(a); a = a._parent; }
    const theirs = []; let b = node; while (b) { theirs.push(b); b = b._parent; }
    const common = mine.find((x) => theirs.includes(x));
    if (!common) { Log.error('get_path_to: nodes are not in the same tree'); return new NodePath(''); }
    const up = mine.indexOf(common), down = theirs.indexOf(common);
    const parts = []; for (let i = 0; i < up; i++) parts.push('..');
    for (let i = down - 1; i >= 0; i--) parts.push(theirs[i]._name);
    return new NodePath(parts.length ? parts.join('/') : '.');
  }
  _find_unique(name) {
    const owner_scan = (owner) => {
      const stack = owner._children.slice();
      while (stack.length) { const n = stack.pop(); if (n.unique_name_in_owner && n._owner === owner && n._name === name) return n; stack.push(...n._children); }
      return null;
    };
    return owner_scan(this) || (this._owner ? owner_scan(this._owner) : null);
  }
  get_node_or_null(path) {
    const np = path instanceof NodePath ? path : new NodePath(path);
    let cur;
    if (np.absolute) { if (!this._tree) return null; cur = null; }
    else cur = this;
    for (let i = 0; i < np.names.length; i++) {
      const nm = np.names[i];
      if (cur === null) { // absolute: first name must be root
        cur = this._tree.root._name === nm ? this._tree.root : null; if (!cur) return null; continue;
      }
      if (nm === '.') continue;
      if (nm === '..') { cur = cur._parent; if (!cur) return null; continue; }
      if (nm[0] === '%') { cur = cur._find_unique(nm.slice(1)); if (!cur) return null; continue; }
      let next = null; const ch = cur._children;
      for (let j = 0; j < ch.length; j++) if (ch[j]._name === nm) { next = ch[j]; break; }
      if (!next) return null; cur = next;
    }
    return cur;
  }
  get_node(path) {
    const n = this.get_node_or_null(path);
    if (!n) Log.error(`Node not found: "${path}" (relative to "${this._tree ? this.get_path() : this._name}").`);
    return n;
  }
  has_node(path) { return !!this.get_node_or_null(path); }
  find_child(pattern, recursive = true, owned = true) {
    const re = _wildcard(pattern);
    for (const c of this._children) if (re.test(c._name) && (!owned || c._owner)) return c;
    if (recursive) for (const c of this._children) { const r = c.find_child(pattern, true, owned); if (r) return r; }
    return null;
  }
  find_children(pattern, type = '', recursive = true, owned = true) {
    const re = _wildcard(pattern); const out = [];
    const visit = (n) => { for (const c of n._children) { if (re.test(c._name) && (!owned || c._owner) && (!type || c.is_class(type))) out.push(c); if (recursive) visit(c); } };
    visit(this); return out;
  }
  find_parent(pattern) { const re = _wildcard(pattern); let p = this._parent; while (p) { if (re.test(p._name)) return p; p = p._parent; } return null; }
  get_viewport() { let n = this; while (n) { if (n instanceof Viewport) return n; n = n._parent; } return null; }
  is_greater_than(other) { // true if this is after other in tree order
    if (this._tree && this._tree === other._tree) { this._tree._ensure_order(); return this._tree_index > other._tree_index; }
    return false;
  }
  // ── groups
  add_to_group(group, persistent = false) {
    if (!this._groups) this._groups = new Map();
    if (this._groups.has(group)) return;
    this._groups.set(group, !!persistent);
    if (this._tree) this._tree._add_to_group(group, this);
  }
  remove_from_group(group) {
    if (!this._groups || !this._groups.has(group)) { Log.error(`remove_from_group: node is not in group '${group}'`); return; }
    this._groups.delete(group);
    if (this._tree) this._tree._remove_from_group(group, this);
  }
  is_in_group(group) { return !!this._groups && this._groups.has(group); }
  get_groups() { return this._groups ? [...this._groups.keys()] : []; }
  // ── processing
  get process_mode() { return this._process_mode; }
  set process_mode(m) { this._process_mode = m; if (this._tree) this._tree._proc_dirty = true; }
  get process_priority() { return this._process_priority; }
  set process_priority(p) { this._process_priority = p | 0; if (this._tree) this._tree._proc_dirty = true; }
  get process_physics_priority() { return this._process_physics_priority; }
  set process_physics_priority(p) { this._process_physics_priority = p | 0; if (this._tree) this._tree._proc_dirty = true; }
  set_process(b) { if (this._proc !== !!b) { this._proc = !!b; if (this._tree) this._tree._proc_dirty = true; } }
  is_processing() { return this._proc; }
  set_physics_process(b) { if (this._phys !== !!b) { this._phys = !!b; if (this._tree) this._tree._proc_dirty = true; } }
  is_physics_processing() { return this._phys; }
  set_process_internal(b) { if (this._proc_int !== !!b) { this._proc_int = !!b; if (this._tree) this._tree._proc_dirty = true; } }
  is_processing_internal() { return this._proc_int; }
  set_physics_process_internal(b) { if (this._phys_int !== !!b) { this._phys_int = !!b; if (this._tree) this._tree._proc_dirty = true; } }
  is_physics_processing_internal() { return this._phys_int; }
  set_process_input(b) { this._input_enabled = !!b; if (this._tree) this._tree._proc_dirty = true; }
  is_processing_input() { return !!this._input_enabled; }
  set_process_unhandled_input(b) { this._unhandled = !!b; if (this._tree) this._tree._proc_dirty = true; }
  is_processing_unhandled_input() { return this._unhandled; }
  _effective_process_mode() {
    let n = this;
    while (n) { if (n._process_mode !== ProcessMode.PROCESS_MODE_INHERIT) return n._process_mode; n = n._parent; }
    return ProcessMode.PROCESS_MODE_PAUSABLE;
  }
  can_process() {
    if (!this._tree) return false;
    const m = this._effective_process_mode(); const paused = this._tree.paused;
    if (m === ProcessMode.PROCESS_MODE_DISABLED) return false;
    if (m === ProcessMode.PROCESS_MODE_ALWAYS) return true;
    if (m === ProcessMode.PROCESS_MODE_WHEN_PAUSED) return paused;
    return !paused;
  }
  get_process_delta_time() { return this._tree ? this._tree._process_delta : 0; }
  get_physics_process_delta_time() { return this._tree ? this._tree._physics_delta : 0; }
  propagate_call(method, args = [], parent_first = false) {
    if (parent_first && typeof this[method] === 'function') this[method](...args);
    for (const c of this._children.slice()) c.propagate_call(method, args, parent_first);
    if (!parent_first && typeof this[method] === 'function') this[method](...args);
  }
  propagate_notification(what) { this.notification(what); for (const c of this._children.slice()) c.propagate_notification(what); }
  create_tween() {
    if (!this._tree) { Log.error("Can't create Tween when not inside scene tree."); return null; }
    const t = new Tween(this._tree); t.bind_node(this); this._tree._tweens.push(t); return t;
  }
  // ── freeing
  queue_free() {
    if (this._freed) { Log.error('queue_free: node already freed'); return; }
    if (this._queued) return;
    this._queued = true;
    (this._tree ? this._tree._delete_queue : _globalDeleteQueue).push(this);
  }
  is_queued_for_deletion() { return this._queued; }
  _internal_notification(what) {
    if (what === NOTIFICATION_PREDELETE) {
      if (this._parent) this._parent.remove_child(this);
      while (this._children.length) { const c = this._children[this._children.length - 1]; this.remove_child(c); c.free(); }
      if (this._tweens) { for (const t of this._tweens) t.kill(); this._tweens = null; }
    }
  }
  free() {
    if (this._freed) { Log.error(`free: node '${this._name}' already freed`); return; }
    if (this._blocked > 0) { Log.error(`free: node '${this._name}' is busy (inside its own tree notification); use queue_free()`); return; }
    _nodeLiveCount--;
    super.free();
  }
  // ── duplication via the explicit property schema
  duplicate(flags = 15) {
    const dup = ClassDB.instantiate(this.get_class());
    if (!dup) return null;
    for (const p of ClassDB.get_property_list(this.get_class())) {
      if (p.no_duplicate) continue;
      let v = this[p.name];
      if (v instanceof Resource) { /* shared like Godot unless local_to_scene */ if (v.resource_local_to_scene) v = v.duplicate(true); }
      else if (v && typeof v.clone === 'function') v = v.clone();
      else if (Array.isArray(v)) v = v.slice();
      dup[p.name] = v;
    }
    dup._name = this._name;
    if ((flags & 2) && this._groups) for (const [g, pers] of this._groups) dup.add_to_group(g, pers);
    for (const c of this._children) { const cd = c.duplicate(flags); if (cd) { dup.add_child(cd); if (c._owner === this) cd._owner = dup; } }
    return dup;
  }
  get_tree_string_pretty() {
    const lines = [];
    const visit = (n, prefix, last, root) => {
      lines.push(root ? ' ┖╴' + n._name : prefix + (last ? '┖╴' : '┠╴') + n._name);
      const p = root ? '    ' : prefix + (last ? '   ' : '┃  ');
      n._children.forEach((c, i) => visit(c, p, i === n._children.length - 1, false));
    };
    visit(this, '', true, true); return lines.join('\n');
  }
  get_tree_string() {
    const lines = []; const visit = (n, base) => { for (const c of n._children) { const p = base ? base + '/' + c._name : c._name; lines.push(p); visit(c, p); } };
    visit(this, ''); return lines.join('\n');
  }
  print_tree_pretty() { Log.print('\n' + this.get_tree_string_pretty()); }
  toString() { return `${this._name}:<${this.get_class()}#${this._id}>`; }
}
Node.signals = ['ready', 'renamed', 'tree_entered', 'tree_exiting', 'tree_exited', 'child_entered_tree', 'child_exiting_tree', 'child_order_changed', 'replacing_by'];
ClassDB.register(Node, 'Node', [
  { name: 'name', type: 'string', no_duplicate: true }, { name: 'process_mode', type: 'int' }, { name: 'process_priority', type: 'int' },
  { name: 'process_physics_priority', type: 'int' }, { name: 'unique_name_in_owner', type: 'bool' }, { name: 'editor_description', type: 'string' },
]);
const get_live_node_count = () => _nodeLiveCount;

// Viewport / Window: the tree root. Rendering/input/world hooks are attached by later sections.
class Viewport extends Node {
  constructor(name) {
    super(name);
    this._input_handled = false; this._camera_3d = null; this._camera_2d = null; this._cameras_3d = new Set(); this._cameras_2d = new Set();
    this._world_3d = null; this.canvas_transform = new Transform2D(); this._gui = { hovered: null, pressed: null, focus: null };
    this.transparent_bg = false; this._size = new Vector2(640, 480);
  }
  get_visible_rect() { return new Rect2(0, 0, this._size.x, this._size.y); }
  set_size(v) { this._size = v.clone(); }
  get_camera_3d() { return this._camera_3d; }
  get_camera_2d() { return this._camera_2d; }
  set_input_as_handled() { this._input_handled = true; }
  is_input_handled() { return this._input_handled; }
}
Viewport.signals = ['size_changed', 'gui_focus_changed'];
ClassDB.register(Viewport, 'Viewport', [], { abstract: true });
class Window extends Viewport {}
ClassDB.register(Window, 'Window', [], { abstract: true });

const _pendingTweens = [];
const SceneTreeHooks = { physics_pre: [], physics_post: [], process_pre: [], process_post: [], draw: [], tree_created: [] };

class SceneTree extends GObject {
  constructor(opts = {}) {
    super();
    this._node_count = 0; this._groups = new Map(); this._proc_dirty = true; this._order_dirty = true;
    this._proc_list = []; this._phys_list = []; this._input_list = []; this._order = [];
    this._delete_queue = []; this._timers = []; this._tweens = [];
    this._paused = false; this.current_scene = null; this._pending_scene = null; this._scene_to_free = null; this._current_packed = null;
    this._frame = 0; this._process_delta = 0; this._physics_delta = 0; this._quit_requested = false;
    this.root = new Window('root');
    this.root._tree = null;
    this.root._set_tree(this);
    for (const h of SceneTreeHooks.tree_created) h(this, opts);
    if (opts.main_loop !== false && !Engine._main_loop) Engine.set_main_loop(this);
  }
  get paused() { return this._paused; }
  set paused(p) {
    p = !!p; if (p === this._paused) return; this._paused = p; this._proc_dirty = true;
    this.root.propagate_notification(p ? NOTIFICATION.PAUSED : NOTIFICATION.UNPAUSED);
  }
  get_frame() { return this._frame; }
  get_node_count() { return this._node_count; }
  get_root() { return this.root; }
  // ── groups
  _add_to_group(g, n) { let s = this._groups.get(g); if (!s) { s = new Set(); this._groups.set(g, s); } s.add(n); }
  _remove_from_group(g, n) { const s = this._groups.get(g); if (s) { s.delete(n); if (!s.size) this._groups.delete(g); } }
  has_group(g) { return this._groups.has(g); }
  get_nodes_in_group(g) { const s = this._groups.get(g); if (!s) return []; this._ensure_order(); return [...s].sort((a, b) => a._tree_index - b._tree_index); }
  get_first_node_in_group(g) { const a = this.get_nodes_in_group(g); return a.length ? a[0] : null; }
  get_node_count_in_group(g) { const s = this._groups.get(g); return s ? s.size : 0; }
  call_group_flags(flags, g, method, ...args) {
    let nodes = this.get_nodes_in_group(g); if (flags & 1) nodes.reverse();
    const seen = (flags & 4) ? (this._unique_calls || (this._unique_calls = new Set())) : null;
    if (seen) { const key = g + '|' + method; if (seen.has(key)) return; seen.add(key); }
    for (const n of nodes) {
      if (typeof n[method] !== 'function') continue;
      if (flags & 2) n.call_deferred(method, ...args);
      else { try { n[method](...args); } catch (e) { Log.error(`call_group '${g}'.${method} failed on ${n}`, e); } }
    }
  }
  call_group(g, method, ...args) { this.call_group_flags(0, g, method, ...args); }
  set_group_flags(flags, g, prop, value) { let nodes = this.get_nodes_in_group(g); if (flags & 1) nodes.reverse(); for (const n of nodes) { if (flags & 2) n.set_deferred(prop, value); else n[prop] = value; } }
  set_group(g, prop, value) { this.set_group_flags(0, g, prop, value); }
  notify_group(g, what) { for (const n of this.get_nodes_in_group(g)) n.notification(what); }
  // ── ordering
  _tree_changed() { this._proc_dirty = true; this._order_dirty = true; this.emit_signal('tree_changed'); }
  _ensure_order() {
    if (!this._order_dirty) return;
    const order = this._order; order.length = 0; let idx = 0;
    const stack = [this.root];
    while (stack.length) { const n = stack.pop(); n._tree_index = idx++; order.push(n); for (let i = n._children.length - 1; i >= 0; i--) stack.push(n._children[i]); }
    this._order_dirty = false;
  }
  _rebuild_process_lists() {
    this._ensure_order();
    const P = this._proc_list, F = this._phys_list, I = this._input_list; P.length = F.length = I.length = 0;
    for (const n of this._order) {
      if (n._proc || n._proc_int) P.push(n);
      if (n._phys || n._phys_int) F.push(n);
      if (n._input_enabled || n._unhandled || n._gui_input_capable || typeof n._shortcut_input === 'function' || typeof n._unhandled_key_input === 'function') I.push(n);
    }
    // Stable sort by priority, preserving tree order.
    P.sort((a, b) => a._process_priority - b._process_priority || a._tree_index - b._tree_index);
    F.sort((a, b) => a._process_physics_priority - b._process_physics_priority || a._tree_index - b._tree_index);
    this._proc_dirty = false;
  }
  // ── main loop entry points (called by Engine.iteration)
  _physics_step(delta, real) {
    this._physics_delta = delta;
    for (const h of SceneTreeHooks.physics_pre) h(this, delta);
    this.emit_signal('physics_frame');
    if (this._proc_dirty) this._rebuild_process_lists();
    const list = this._phys_list.slice();
    for (let i = 0; i < list.length; i++) {
      const n = list[i]; if (n._freed || !n._tree || !n.can_process()) continue;
      if (n._phys_int) { n.notification(NOTIFICATION.INTERNAL_PHYSICS_PROCESS); if (n._internal_physics_process) n._internal_physics_process(delta); }
      if (n._phys && n._physics_process) { n.notification(NOTIFICATION.PHYSICS_PROCESS); n._safe_call('_physics_process', delta); }
    }
    this._process_timers(delta, real, true);
    this._process_tweens(delta, real, true);
    MessageQueue.flush();
    if (!this._paused) for (const h of SceneTreeHooks.physics_post) h(this, delta);
    MessageQueue.flush();
    this._frame++;
  }
  _process_step(delta, real) {
    this._process_delta = delta;
    for (const h of SceneTreeHooks.process_pre) h(this, delta);
    this.emit_signal('process_frame');
    if (this._proc_dirty) this._rebuild_process_lists();
    const list = this._proc_list.slice();
    for (let i = 0; i < list.length; i++) {
      const n = list[i]; if (n._freed || !n._tree || !n.can_process()) continue;
      if (n._proc_int) { n.notification(NOTIFICATION.INTERNAL_PROCESS); if (n._internal_process) n._internal_process(delta); }
      if (n._proc && n._process) { n.notification(NOTIFICATION.PROCESS); n._safe_call('_process', delta); }
    }
    this._process_timers(delta, real, false);
    this._process_tweens(delta, real, false);
    for (const h of SceneTreeHooks.process_post) h(this, delta);
    MessageQueue.flush();
    this._flush_delete_queue();
    this._flush_scene_change();
    this._unique_calls = null;
    if (this._quit_requested) { Engine.stop(); this.emit_signal('quit_requested'); }
  }
  _draw() { let drew = false; for (const h of SceneTreeHooks.draw) if (h(this)) drew = true; return drew; }
  _flush_delete_queue() {
    const flush = (q) => { while (q.length) { const n = q.shift(); if (!n._freed) n.free(); } };
    flush(this._delete_queue); flush(_globalDeleteQueue);
  }
  queue_delete(obj) { if (obj instanceof Node) obj.queue_free(); else this._delete_queue.push(obj); }
  // ── timers/tweens
  create_timer(time_sec, process_always = true, process_in_physics = false, ignore_time_scale = false) {
    const t = new SceneTreeTimer(time_sec, process_always, process_in_physics, ignore_time_scale);
    this._timers.push(t); return t;
  }
  _process_timers(delta, real, physics) {
    if (!this._timers.length) return;
    const list = this._timers.slice();
    for (const t of list) {
      if (t._freed || t.process_in_physics !== physics) continue;
      if (this._paused && !t.process_always) continue;
      t.time_left -= t.ignore_time_scale ? real : delta;
      if (t.time_left <= 0) {
        t.time_left = 0;
        const i = this._timers.indexOf(t); if (i >= 0) this._timers.splice(i, 1);
        t.emit_signal('timeout'); t.free();
      }
    }
  }
  create_tween() { const t = new Tween(this); this._tweens.push(t); return t; }
  get_processed_tweens() { return this._tweens.filter((t) => t.is_valid()); }
  _process_tweens(delta, real, physics) {
    if (_pendingTweens.length) { for (const t of _pendingTweens) { t._tree = this; this._tweens.push(t); } _pendingTweens.length = 0; }
    if (!this._tweens.length) return;
    const list = this._tweens.slice();
    for (const t of list) {
      if (!t.is_valid()) continue;
      if ((t._process_mode === 0) !== physics) continue; // 0 = TWEEN_PROCESS_PHYSICS
      if (!t._can_process(this._paused)) continue;
      t._step(t._ignore_time_scale ? real : delta);
    }
    const keep = [];
    for (const t of this._tweens) { if (t.is_valid()) keep.push(t); else t._release(); }
    this._tweens = keep;
  }
  // ── scenes
  change_scene_to_node(node) {
    if (!node) return Err.ERR_INVALID_PARAMETER;
    if (node._tree) return Err.ERR_UNCONFIGURED;
    if (this.current_scene) { const old = this.current_scene; this.root.remove_child(old); this._scene_to_free = old; }
    this.current_scene = null;
    if (this._pending_scene && this._pending_scene !== node && !this._pending_scene._freed) this._pending_scene.free();
    this._pending_scene = node;
    return Err.OK;
  }
  change_scene_to_packed(packed) {
    if (!packed || !(packed instanceof PackedScene) || !packed.can_instantiate()) return Err.ERR_INVALID_PARAMETER;
    const inst = packed.instantiate(); if (!inst) return Err.ERR_CANT_CREATE;
    this._current_packed = packed;
    return this.change_scene_to_node(inst);
  }
  reload_current_scene() {
    if (!this.current_scene) return Err.ERR_UNCONFIGURED;
    if (!this._current_packed) return Err.ERR_UNCONFIGURED;
    return this.change_scene_to_packed(this._current_packed);
  }
  unload_current_scene() { if (this.current_scene) { const s = this.current_scene; this.root.remove_child(s); s.free(); this.current_scene = null; } }
  _flush_scene_change() {
    if (this._scene_to_free) { const s = this._scene_to_free; this._scene_to_free = null; if (!s._freed) s.free(); }
    if (this._pending_scene) {
      const n = this._pending_scene; this._pending_scene = null;
      if (n._freed) return;
      this.root.add_child(n); this.current_scene = n;
      this.emit_signal('scene_changed');
    }
  }
  quit(exit_code = 0) { this._quit_requested = true; this.exit_code = exit_code; }
  // Free the whole tree and everything owned by it.
  free() {
    if (this._freed) return;
    if (Engine._main_loop === this) Engine.set_main_loop(null);
    for (const t of this._timers.slice()) if (!t._freed) t.free();
    this._timers.length = 0;
    for (const t of this._tweens) { t.kill(); t._release(); } this._tweens.length = 0;
    if (this._pending_scene && !this._pending_scene._freed) this._pending_scene.free();
    if (this._scene_to_free && !this._scene_to_free._freed) this._scene_to_free.free();
    this._flush_delete_queue();
    const root = this.root;
    root._set_tree(null);
    while (root._children.length) { const c = root._children[root._children.length - 1]; root.remove_child(c); c.free(); }
    if (root._on_tree_free) root._on_tree_free();
    root.free();
    super.free();
  }
}
SceneTree.signals = ['node_added', 'node_removed', 'node_renamed', 'tree_changed', 'process_frame', 'physics_frame', 'scene_changed', 'quit_requested'];
ClassDB.register(SceneTree, 'SceneTree', [], { abstract: true });

class SceneTreeTimer extends GObject {
  constructor(t, process_always, process_in_physics, ignore_time_scale) {
    super(); this.time_left = t; this.process_always = process_always; this.process_in_physics = process_in_physics; this.ignore_time_scale = ignore_time_scale;
  }
}
SceneTreeTimer.signals = ['timeout'];
ClassDB.register(SceneTreeTimer, 'SceneTreeTimer', [], { abstract: true });

// ── CanvasItem / Node2D
class CanvasItem extends Node {
  constructor(name) {
    super(name);
    this._visible = true; this.modulate = new Color(1, 1, 1, 1); this.self_modulate = new Color(1, 1, 1, 1);
    this._z_index = 0; this.z_as_relative = true; this.top_level = false;
    this._gx = new Transform2D(); this._gdirty = true; this._draw_cmds = null; this._redraw = true;
  }
  get visible() { return this._visible; }
  set visible(v) { v = !!v; if (v === this._visible) return; this._visible = v; this.notification(NOTIFICATION.VISIBILITY_CHANGED); this.emit_signal('visibility_changed'); }
  show() { this.visible = true; } hide() { this.visible = false; }
  is_visible_in_tree() { let n = this; while (n) { if (n instanceof CanvasItem && !n._visible) return false; n = n._parent; } return !!this._tree; }
  get z_index() { return this._z_index; } set z_index(z) { this._z_index = MathUtil.clamp(z | 0, -4096, 4096); }
  _effective_z() { let z = this._z_index; if (this.z_as_relative && this._parent instanceof CanvasItem) z += this._parent._effective_z(); return z; }
  get_transform() { return new Transform2D(); }
  _parent_canvas() { return !this.top_level && this._parent instanceof CanvasItem ? this._parent : null; }
  get_global_transform() {
    if (this._gdirty) {
      const p = this._parent_canvas();
      if (p) Transform2D.mul_into(p.get_global_transform(), this._local_xform_ref(), this._gx); else this._gx.copy(this._local_xform_ref());
      this._gdirty = false;
    }
    return this._gx;
  }
  _local_xform_ref() { return Transform2D.IDENTITY; }
  _propagate_xform_dirty() {
    if (this._gdirty) return; this._gdirty = true;
    for (const c of this._children) if (c instanceof CanvasItem) c._propagate_xform_dirty();
  }
  _on_enter_tree_internal() { this._gdirty = false; this._propagate_xform_dirty(); }
  // Immediate-mode drawing, re-recorded when queue_redraw() is called (Godot _draw semantics).
  queue_redraw() { this._redraw = true; }
  _collect_draw() {
    if (!this._redraw) return this._draw_cmds;
    this._redraw = false;
    if (typeof this._draw !== 'function') { this._draw_cmds = null; return null; }
    this._draw_cmds = [];
    this._safe_call('_draw');
    return this._draw_cmds;
  }
  _cmd(c) { if (!this._draw_cmds) { Log.error('draw_* may only be called inside _draw()'); return; } this._draw_cmds.push(c); }
  draw_rect(rect, color, filled = true, width = 1) {
    if (filled) this._cmd({ k: 'rect', x: rect.position.x, y: rect.position.y, w: rect.size.x, h: rect.size.y, color: color.clone(), tex: null });
    else { const x = rect.position.x, y = rect.position.y, w = rect.size.x, h = rect.size.y, c = color;
      this.draw_rect(new Rect2(x, y, w, width), c); this.draw_rect(new Rect2(x, y + h - width, w, width), c);
      this.draw_rect(new Rect2(x, y, width, h), c); this.draw_rect(new Rect2(x + w - width, y, width, h), c); }
  }
  draw_texture(tex, pos, modulate = Color.WHITE) { this._cmd({ k: 'rect', x: pos.x, y: pos.y, w: tex.get_width(), h: tex.get_height(), color: modulate.clone(), tex }); }
  draw_texture_rect(tex, rect, tile = false, modulate = Color.WHITE) { this._cmd({ k: 'rect', x: rect.position.x, y: rect.position.y, w: rect.size.x, h: rect.size.y, color: modulate.clone(), tex }); }
  draw_circle(pos, radius, color, segments = 32) { this._cmd({ k: 'circle', x: pos.x, y: pos.y, r: radius, color: color.clone(), seg: segments }); }
  draw_line(a, b, color, width = 1) { this._cmd({ k: 'line', ax: a.x, ay: a.y, bx: b.x, by: b.y, w: width, color: color.clone() }); }
  draw_colored_polygon(points, color) { this._cmd({ k: 'poly', pts: points.map((p) => [p.x, p.y]), color: color.clone() }); }
}
CanvasItem.signals = ['visibility_changed', 'draw'];
ClassDB.register(CanvasItem, 'CanvasItem', [
  { name: 'visible', type: 'bool' }, { name: 'modulate', type: 'Color' }, { name: 'self_modulate', type: 'Color' },
  { name: 'z_index', type: 'int' }, { name: 'z_as_relative', type: 'bool' }, { name: 'top_level', type: 'bool' },
], { abstract: true });

class Node2D extends CanvasItem {
  constructor(name) { super(name); this._pos = new Vector2(); this._rot = 0; this._scale = new Vector2(1, 1); this._skew = 0; this._lx = new Transform2D(); this._ldirty = false; }
  _local_xform_ref() {
    if (this._ldirty) {
      const c = Math.cos(this._rot), s = Math.sin(this._rot);
      this._lx.x.set(c * this._scale.x, s * this._scale.x); this._lx.y.set(-s * this._scale.y, c * this._scale.y); this._lx.origin.copy(this._pos);
      this._ldirty = false;
    }
    return this._lx;
  }
  _changed() { this._ldirty = true; this._gdirty = false; this._propagate_xform_dirty(); }
  get position() { return this._pos.clone(); } set position(v) { this._pos.copy(v); this._changed(); }
  get rotation() { return this._rot; } set rotation(r) { this._rot = r; this._changed(); }
  get rotation_degrees() { return MathUtil.rad_to_deg(this._rot); } set rotation_degrees(d) { this.rotation = MathUtil.deg_to_rad(d); }
  get scale() { return this._scale.clone(); } set scale(v) { this._scale.copy(v); this._changed(); }
  get transform() { return this._local_xform_ref().clone(); }
  set transform(t) { this._pos.copy(t.origin); this._rot = t.get_rotation(); this._scale.copy(t.get_scale()); this._changed(); }
  get_transform() { return this.transform; }
  get global_transform() { return this.get_global_transform().clone(); }
  set global_transform(t) { const p = this._parent_canvas(); this.transform = p ? p.get_global_transform().affine_inverse().mul(t) : t; }
  get global_position() { return this.get_global_transform().origin.clone(); }
  set global_position(v) { const p = this._parent_canvas(); this.position = p ? p.get_global_transform().affine_inverse().xform(v) : v; }
  get global_rotation() { return this.get_global_transform().get_rotation(); }
  set global_rotation(r) { const p = this._parent_canvas(); this.rotation = p ? r - p.get_global_transform().get_rotation() : r; }
  get global_scale() { return this.get_global_transform().get_scale(); }
  translate(off) { this.position = this._pos.add(off); }
  global_translate(off) { this.global_position = this.global_position.add(off); }
  rotate(r) { this.rotation = this._rot + r; }
  look_at(p) { this.rotation = this._rot + this.get_angle_to(p); }
  get_angle_to(p) { return this.to_local(p).angle() * Math.sign(this._scale.x * this._scale.y || 1); }
  to_local(p) { return this.get_global_transform().affine_inverse().xform(p); }
  to_global(p) { return this.get_global_transform().xform(p); }
  _capture_global_for_reparent() { return this.global_transform; }
  _restore_global_after_reparent(g) { this.global_transform = g; }
}
ClassDB.register(Node2D, 'Node2D', [
  { name: 'position', type: 'Vector2' }, { name: 'rotation', type: 'float' }, { name: 'scale', type: 'Vector2' },
]);

// ── Node3D
class Node3D extends Node {
  constructor(name) {
    super(name);
    this._local = new Transform3D(); this._euler = new Vector3(); this._scl = new Vector3(1, 1, 1);
    this._xdirty = false; this._edirty = false; // _xdirty: local from euler/scale; _edirty: euler/scale from local
    this._global = new Transform3D(); this._gdirty = true; this._gver = 0;
    this._visible = true; this._top_level = false;
  }
  _update_local() {
    if (this._xdirty) {
      const b = Basis.from_euler(this._euler).scaled_local(this._scl);
      this._local.basis.copy(b); this._xdirty = false;
    }
  }
  _update_euler() {
    if (this._edirty) { this._scl.copy(this._local.basis.get_scale()); this._euler.copy(this._local.basis.orthonormalized().get_euler()); this._edirty = false; }
  }
  _propagate_xform_dirty() {
    if (this._gdirty) return; this._gdirty = true; this._gver++;
    for (const c of this._children) if (c instanceof Node3D && !c._top_level) c._propagate_xform_dirty();
  }
  _changed_local() { this._gdirty = false; this._propagate_xform_dirty(); }
  _on_enter_tree_internal() { this._gdirty = false; this._propagate_xform_dirty(); }
  get_parent_node_3d() { const p = this._parent; return p instanceof Node3D ? p : null; }
  get transform() { this._update_local(); return this._local.clone(); }
  set transform(t) { this._local.copy(t); this._xdirty = false; this._edirty = true; this._changed_local(); }
  get basis() { this._update_local(); return this._local.basis.clone(); }
  set basis(b) { this._update_local(); this._local.basis.copy(b); this._edirty = true; this._changed_local(); }
  get position() { return this._local.origin.clone(); }
  set position(v) { this._local.origin.copy(v); this._changed_local(); }
  get rotation() { this._update_euler(); return this._euler.clone(); }
  set rotation(e) { this._update_euler(); this._euler.copy(e); this._xdirty = true; this._changed_local(); }
  get rotation_degrees() { const r = this.rotation; return new Vector3(MathUtil.rad_to_deg(r.x), MathUtil.rad_to_deg(r.y), MathUtil.rad_to_deg(r.z)); }
  set rotation_degrees(d) { this.rotation = new Vector3(MathUtil.deg_to_rad(d.x), MathUtil.deg_to_rad(d.y), MathUtil.deg_to_rad(d.z)); }
  get scale() { this._update_euler(); return this._scl.clone(); }
  set scale(s) { this._update_euler(); this._scl.copy(s); this._xdirty = true; this._changed_local(); }
  get quaternion() { this._update_local(); return this._local.basis.get_rotation_quaternion(); }
  set quaternion(q) { this._update_euler(); this._local.basis.copy(Basis.from_quaternion(q).scaled_local(this._scl)); this._edirty = true; this._xdirty = false; this._changed_local(); }
  get top_level() { return this._top_level; }
  set top_level(v) { this._top_level = !!v; this._gdirty = false; this._propagate_xform_dirty(); }
  _global_ref() {
    if (this._gdirty) {
      this._update_local();
      const p = this._top_level ? null : this.get_parent_node_3d();
      if (p) Transform3D.mul_into(p._global_ref(), this._local, this._global); else this._global.copy(this._local);
      this._gdirty = false;
    }
    return this._global;
  }
  get global_transform() { return this._global_ref().clone(); }
  set global_transform(t) {
    const p = this._top_level ? null : this.get_parent_node_3d();
    this.transform = p ? p._global_ref().affine_inverse().mul(t) : t;
  }
  get global_position() { return this._global_ref().origin.clone(); }
  set global_position(v) { const g = this.global_transform; g.origin = v.clone(); this.global_transform = g; }
  get global_basis() { return this._global_ref().basis.clone(); }
  get global_rotation() { return this._global_ref().basis.orthonormalized().get_euler(); }
  set global_rotation(e) { const g = this.global_transform; g.basis = Basis.from_euler(e).scaled_local(g.basis.get_scale()); this.global_transform = g; }
  get visible() { return this._visible; }
  set visible(v) { v = !!v; if (v === this._visible) return; this._visible = v; this.notification(NOTIFICATION.VISIBILITY_CHANGED); this.emit_signal('visibility_changed'); }
  show() { this.visible = true; } hide() { this.visible = false; }
  is_visible_in_tree() { let n = this; while (n) { if (n instanceof Node3D && !n._visible) return false; n = n._parent; } return !!this._tree; }
  rotate(axis, angle) { this._rotate_keep_origin(axis, angle); }
  rotate_object_local(axis, angle) { this.transform = this.transform.rotated_local(axis, angle); }
  rotate_x(a) { this._rotate_keep_origin(new Vector3(1, 0, 0), a); }
  rotate_y(a) { this._rotate_keep_origin(new Vector3(0, 1, 0), a); }
  rotate_z(a) { this._rotate_keep_origin(new Vector3(0, 0, 1), a); }
  _rotate_keep_origin(axis, a) { const t = this.transform; t.basis = Basis.from_axis_angle(axis, a).mul(t.basis); this.transform = t; }
  translate(off) { const t = this.transform; this.position = t.origin.add(t.basis.xform(off)); }
  translate_object_local(off) { this.translate(off); }
  global_translate(off) { this.global_position = this.global_position.add(off); }
  look_at(target, up = Vector3.UP, use_model_front = false) {
    const g = this.global_transform; const t = g.looking_at(target, up, use_model_front);
    t.basis = t.basis.scaled_local(g.basis.get_scale()); this.global_transform = t;
  }
  look_at_from_position(pos, target, up = Vector3.UP) { const g = this.global_transform; g.origin = pos.clone(); this.global_transform = g; this.look_at(target, up); }
  to_local(p) { return this._global_ref().affine_inverse().xform(p); }
  to_global(p) { return this._global_ref().xform(p); }
  _capture_global_for_reparent() { return this.global_transform; }
  _restore_global_after_reparent(g) { this.global_transform = g; }
}
Node3D.signals = ['visibility_changed'];
ClassDB.register(Node3D, 'Node3D', [
  { name: 'transform', type: 'Transform3D' }, { name: 'visible', type: 'bool' }, { name: 'top_level', type: 'bool' },
]);

// ── Variant codec (explicit per-type schema; used by PackedScene and §12 serialization)
const VariantCodec = {
  _math: { Vector2, Vector3, Vector4, Quaternion, Color },
  encode(v, ctx) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') return v;
    if (v instanceof Vector2) return { t: 'Vector2', v: [v.x, v.y] };
    if (v instanceof Vector3) return { t: 'Vector3', v: [v.x, v.y, v.z] };
    if (v instanceof Vector4) return { t: 'Vector4', v: [v.x, v.y, v.z, v.w] };
    if (v instanceof Quaternion) return { t: 'Quaternion', v: [v.x, v.y, v.z, v.w] };
    if (v instanceof Color) return { t: 'Color', v: [v.r, v.g, v.b, v.a] };
    if (v instanceof Rect2) return { t: 'Rect2', v: [v.position.x, v.position.y, v.size.x, v.size.y] };
    if (v instanceof AABB) return { t: 'AABB', v: [v.position.x, v.position.y, v.position.z, v.size.x, v.size.y, v.size.z] };
    if (v instanceof Plane) return { t: 'Plane', v: [v.normal.x, v.normal.y, v.normal.z, v.d] };
    if (v instanceof Basis) return { t: 'Basis', v: [...v.x.toArray(), ...v.y.toArray(), ...v.z.toArray()] };
    if (v instanceof Transform3D) return { t: 'Transform3D', v: [...v.basis.x.toArray(), ...v.basis.y.toArray(), ...v.basis.z.toArray(), ...v.origin.toArray()] };
    if (v instanceof Transform2D) return { t: 'Transform2D', v: [v.x.x, v.x.y, v.y.x, v.y.y, v.origin.x, v.origin.y] };
    if (v instanceof NodePath) return { t: 'NodePath', v: v.toString() };
    if (ArrayBuffer.isView(v)) return { t: v.constructor.name, v: Array.from(v) };
    if (Array.isArray(v)) return { t: 'Array', v: v.map((x) => this.encode(x, ctx)) };
    if (v instanceof Resource) {
      if (!ctx) throw new Error('VariantCodec: Resource values need a serialization context');
      return { t: 'Resource', v: ctx.ref_resource(v) };
    }
    if (v instanceof GObject) throw new Error(`VariantCodec: cannot encode Object reference ${v} (only Resources are serializable by value)`);
    if (v instanceof Map) return { t: 'Dictionary', v: [...v].map(([k, x]) => [this.encode(k, ctx), this.encode(x, ctx)]) };
    if (t === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {}; for (const k of Object.keys(v)) out[k] = this.encode(v[k], ctx); return { t: 'Object', v: out };
    }
    throw new Error('VariantCodec: unsupported value type ' + (v.constructor ? v.constructor.name : t));
  },
  decode(d, ctx) {
    if (d === null || typeof d !== 'object') return d;
    const a = d.v;
    switch (d.t) {
      case 'Vector2': return new Vector2(a[0], a[1]);
      case 'Vector3': return new Vector3(a[0], a[1], a[2]);
      case 'Vector4': return new Vector4(a[0], a[1], a[2], a[3]);
      case 'Quaternion': return new Quaternion(a[0], a[1], a[2], a[3]);
      case 'Color': return new Color(a[0], a[1], a[2], a[3]);
      case 'Rect2': return new Rect2(a[0], a[1], a[2], a[3]);
      case 'AABB': return new AABB(new Vector3(a[0], a[1], a[2]), new Vector3(a[3], a[4], a[5]));
      case 'Plane': return new Plane(new Vector3(a[0], a[1], a[2]), a[3]);
      case 'Basis': return new Basis(new Vector3(a[0], a[1], a[2]), new Vector3(a[3], a[4], a[5]), new Vector3(a[6], a[7], a[8]));
      case 'Transform3D': return new Transform3D(new Basis(new Vector3(a[0], a[1], a[2]), new Vector3(a[3], a[4], a[5]), new Vector3(a[6], a[7], a[8])), new Vector3(a[9], a[10], a[11]));
      case 'Transform2D': return new Transform2D(new Vector2(a[0], a[1]), new Vector2(a[2], a[3]), new Vector2(a[4], a[5]));
      case 'NodePath': return new NodePath(a);
      case 'Float32Array': return new Float32Array(a);
      case 'Uint16Array': return new Uint16Array(a);
      case 'Uint32Array': return new Uint32Array(a);
      case 'Uint8Array': return new Uint8Array(a);
      case 'Array': return a.map((x) => this.decode(x, ctx));
      case 'Dictionary': return new Map(a.map(([k, x]) => [this.decode(k, ctx), this.decode(x, ctx)]));
      case 'Object': { const o = {}; for (const k of Object.keys(a)) o[k] = this.decode(a[k], ctx); return o; }
      case 'Resource': if (!ctx) throw new Error('VariantCodec: Resource reference without context'); return ctx.get_resource(a);
    }
    throw new Error('VariantCodec: unknown encoded type ' + d.t);
  },
};

// Resource table shared by PackedScene and ResourceSaver-style serialization.
class _SerializeContext {
  constructor() { this.resources = []; this._map = new Map(); }
  ref_resource(r) {
    if (r.resource_path && !r.resource_local_to_scene) return { path: r.resource_path, cls: r.get_class() };
    if (this._map.has(r)) return { id: this._map.get(r) };
    const id = this.resources.length; this._map.set(r, id); this.resources.push(null);
    const props = {};
    for (const p of ClassDB.get_property_list(r.get_class())) { if (p.transient) continue; props[p.name] = VariantCodec.encode(r[p.name], this); }
    this.resources[id] = { cls: r.get_class(), props };
    return { id };
  }
}
class _DeserializeContext {
  constructor(resources, external) { this.table = resources || []; this.cache = new Map(); this.external = external; }
  get_resource(ref) {
    if (ref.path !== undefined) {
      const r = this.external ? this.external(ref.path, ref.cls) : null;
      if (!r) Log.error('Missing external resource', ref.path);
      return r;
    }
    if (this.cache.has(ref.id)) return this.cache.get(ref.id);
    const def = this.table[ref.id]; if (!def) throw new Error('Invalid resource id ' + ref.id);
    const r = ClassDB.instantiate(def.cls); if (!r) throw new Error('Cannot instantiate resource class ' + def.cls);
    this.cache.set(ref.id, r);
    for (const k of Object.keys(def.props)) r[k] = VariantCodec.decode(def.props[k], this);
    if (r._after_deserialize) r._after_deserialize();
    return r;
  }
}

// PackedScene: snapshot of a node branch (root + nodes owned by root), with persistent signal connections.
const GEN_EDIT_STATE_DISABLED = 0;
class PackedScene extends Resource {
  constructor() { super(); this._state = null; }
  pack(root) {
    if (!(root instanceof Node)) { Log.error('PackedScene.pack: root must be a Node'); return Err.ERR_INVALID_PARAMETER; }
    const ctx = new _SerializeContext(); const nodes = []; const index = new Map();
    const visit = (n, parentIdx) => {
      if (n !== root && n._owner !== root) return; // Godot packs only nodes owned by the root
      const idx = nodes.length; index.set(n, idx);
      const props = {};
      for (const p of ClassDB.get_property_list(n.get_class())) { if (p.name === 'name' || p.transient) continue; props[p.name] = VariantCodec.encode(n[p.name], ctx); }
      nodes.push({ cls: n.get_class(), name: n._name, parent: parentIdx, props, groups: n._groups ? [...n._groups].filter(([, pers]) => pers).map(([g]) => g) : [] });
      for (const c of n._children) visit(c, idx);
    };
    visit(root, -1);
    const conns = [];
    for (const [n, i] of index) {
      if (!n._signals) continue;
      for (const [sig, list] of n._signals) for (const c of list) {
        if (!(c.flags & ConnectFlags.CONNECT_PERSIST)) continue;
        if (typeof c.callable.method !== 'string' || !index.has(c.callable.object)) { Log.warn('PackedScene.pack: skipping non-persistable connection', sig); continue; }
        conns.push({ from: i, signal: sig, to: index.get(c.callable.object), method: c.callable.method, flags: c.flags, binds: (c.callable.bound || []).map((b) => VariantCodec.encode(b, ctx)) });
      }
    }
    this._state = { version: 1, nodes, resources: ctx.resources, connections: conns };
    this.emit_changed();
    return Err.OK;
  }
  can_instantiate() { return !!this._state && this._state.nodes.length > 0; }
  instantiate(edit_state = GEN_EDIT_STATE_DISABLED) {
    if (!this.can_instantiate()) { Log.error('PackedScene.instantiate: scene is empty'); return null; }
    const ctx = new _DeserializeContext(this._state.resources, PackedScene.external_resource_resolver);
    const made = [];
    for (const def of this._state.nodes) {
      const n = ClassDB.instantiate(def.cls);
      if (!n) { for (const m of made) if (!m._parent && !m._freed) m.free(); return null; }
      for (const k of Object.keys(def.props)) {
        try { n[k] = VariantCodec.decode(def.props[k], ctx); } catch (e) { Log.error(`PackedScene: failed to set ${def.cls}.${k}`, e); }
      }
      n._name = def.name;
      for (const g of def.groups) n.add_to_group(g, true);
      if (def.parent >= 0) made[def.parent].add_child(n);
      made.push(n);
    }
    const root = made[0];
    for (let i = 1; i < made.length; i++) made[i]._owner = root;
    for (const c of this._state.connections) {
      const cal = new Callable(made[c.to], c.method, c.binds.length ? c.binds.map((b) => VariantCodec.decode(b, ctx)) : null);
      made[c.from].connect(c.signal, cal, c.flags);
    }
    root.scene_file_path = this.resource_path;
    root.notification(NOTIFICATION.SCENE_INSTANTIATED);
    return root;
  }
  get_state() { return this._state; }
  // Plain-data form (already schema-encoded) for storage.
  to_data() { return this._state ? JSON.parse(JSON.stringify(this._state)) : null; }
  static from_data(data) { const p = new PackedScene(); p._state = data; return p; }
}
PackedScene.external_resource_resolver = null;
ClassDB.register(PackedScene, 'PackedScene', [{ name: '_state', type: 'Object', transient: true }]);

// §6 ─────────────────────────────────────────────────────────────────────────
// Backend abstraction: a Backend owns a GPU context and tracks every object it creates (GPUStats).
// A Renderer (GL or WebGPU) consumes the backend-agnostic RenderList built by extract_render_list().
class GPUStats {
  constructor() { this.reset_all(); }
  reset_all() {
    this.counts = { buffer: 0, texture: 0, vao: 0, program: 0, shader: 0, framebuffer: 0, renderbuffer: 0, sampler: 0, pipeline: 0, bindgroup: 0 };
    this.bytes = { buffer: 0, texture: 0 };
    this.frame = { draw_calls: 0, primitives: 0, objects: 0, culled: 0, shadow_draw_calls: 0, batches_2d: 0, items_2d: 0 };
  }
  reset_frame() { const f = this.frame; for (const k in f) f[k] = 0; }
  total_objects() { let n = 0; for (const k in this.counts) n += this.counts[k]; return n; }
}
const _liveBackends = new Set();
Performance._providers.push((id) => {
  if (!id.startsWith('render/')) return undefined;
  let v = 0;
  for (const b of _liveBackends) {
    const s = b.stats;
    if (id === Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME) v += s.frame.draw_calls;
    else if (id === Performance.RENDER_TOTAL_OBJECTS_IN_FRAME) v += s.frame.objects;
    else if (id === Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME) v += s.frame.primitives;
    else if (id === Performance.RENDER_TEXTURE_MEM_USED) v += s.bytes.texture;
    else if (id === Performance.RENDER_BUFFER_MEM_USED) v += s.bytes.buffer;
    else return undefined;
  }
  return v;
});
Performance._providers.push((id) => {
  if (id === Performance.OBJECT_NODE_COUNT) return _nodeLiveCount;
  if (id === Performance.OBJECT_RESOURCE_COUNT) { let n = 0; for (const v of _resourceCounts.values()) n += v; return n; }
  return undefined;
});

class ShaderCompileError extends Error {}

// Per-backend GPU cache on a Resource. Entries are invalidated by context generation (context loss).
const GPUCache = {
  get(res, backend) {
    const m = res._gpu; if (!m) return null; const e = m.get(backend);
    if (!e) return null;
    if (e.gen !== backend.gen) { m.delete(backend); return null; }
    return e;
  },
  set(res, backend, entry) {
    entry.gen = backend.gen;
    (res._gpu || (res._gpu = new Map())).set(backend, entry);
    backend._owners.add(res);
    return entry;
  },
  release(res, backend) {
    const m = res._gpu; if (!m) return; const e = m.get(backend); if (!e) return;
    m.delete(backend); backend._owners.delete(res);
    if (e.gen === backend.gen && !backend.lost) backend.release_entry(e);
  },
  release_all(res) { if (!res._gpu) return; for (const b of [...res._gpu.keys()]) GPUCache.release(res, b); },
};

// ── Image / textures
class Image extends Resource {
  constructor() { super(); this.width = 0; this.height = 0; this.data = new Uint8Array(0); }
  static create(w, h, fill = null) {
    const img = new Image(); img.width = w | 0; img.height = h | 0; img.data = new Uint8Array(img.width * img.height * 4);
    if (fill) img.fill(fill); return img;
  }
  static create_from_data(w, h, rgba8) {
    if (rgba8.length !== w * h * 4) throw new RangeError(`Image.create_from_data: expected ${w * h * 4} bytes, got ${rgba8.length}`);
    const img = new Image(); img.width = w; img.height = h; img.data = new Uint8Array(rgba8); return img;
  }
  // Decodes browser image sources (HTMLImageElement/ImageBitmap/canvas) via a 2D canvas.
  static from_source(src) {
    const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
    return Image.create_from_data(w, h, ctx.getImageData(0, 0, w, h).data);
  }
  get_width() { return this.width; } get_height() { return this.height; } get_size() { return new Vector2(this.width, this.height); }
  fill(c) { const r = Math.round(MathUtil.clamp(c.r, 0, 1) * 255), g = Math.round(MathUtil.clamp(c.g, 0, 1) * 255), b = Math.round(MathUtil.clamp(c.b, 0, 1) * 255), a = Math.round(MathUtil.clamp(c.a, 0, 1) * 255); for (let i = 0; i < this.data.length; i += 4) { this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a; } this.emit_changed(); }
  set_pixel(x, y, c) { const i = (y * this.width + x) * 4; this.data[i] = Math.round(c.r * 255); this.data[i + 1] = Math.round(c.g * 255); this.data[i + 2] = Math.round(c.b * 255); this.data[i + 3] = Math.round(c.a * 255); }
  get_pixel(x, y) { const i = (y * this.width + x) * 4; return new Color(this.data[i] / 255, this.data[i + 1] / 255, this.data[i + 2] / 255, this.data[i + 3] / 255); }
}
ClassDB.register(Image, 'Image', [{ name: 'width', type: 'int' }, { name: 'height', type: 'int' }, { name: 'data', type: 'Uint8Array' }]);

const TextureFilter = Object.freeze({ NEAREST: 0, LINEAR: 1, NEAREST_WITH_MIPMAPS: 2, LINEAR_WITH_MIPMAPS: 3 });
class Texture2D extends Resource {
  get_width() { return 0; } get_height() { return 0; } get_size() { return new Vector2(this.get_width(), this.get_height()); }
  dispose() { GPUCache.release_all(this); super.dispose(); }
}
ClassDB.register(Texture2D, 'Texture2D', [], { abstract: true });
class ImageTexture extends Texture2D {
  constructor() { super(); this._image = null; this._version = 0; this.filter = TextureFilter.LINEAR_WITH_MIPMAPS; this.repeat = false; }
  static create_from_image(img) { const t = new ImageTexture(); t.set_image(img); return t; }
  set_image(img) { this._image = img; this._version++; this.emit_changed(); }
  update(img) { if (this._image && (img.width !== this._image.width || img.height !== this._image.height)) Log.warn('ImageTexture.update: size changed; texture will be recreated'); this.set_image(img); }
  get_image() { return this._image; }
  get_width() { return this._image ? this._image.width : 0; } get_height() { return this._image ? this._image.height : 0; }
  get image() { return this._image; } set image(i) { this.set_image(i); }
}
ClassDB.register(ImageTexture, 'ImageTexture', [{ name: 'image', type: 'Resource' }, { name: 'filter', type: 'int' }, { name: 'repeat', type: 'bool' }]);

// ── Meshes
const PrimitiveType = Object.freeze({ PRIMITIVE_POINTS: 0, PRIMITIVE_LINES: 1, PRIMITIVE_LINE_STRIP: 2, PRIMITIVE_TRIANGLES: 3, PRIMITIVE_TRIANGLE_STRIP: 4 });
class Mesh extends Resource {
  constructor() { super(); this._surfaces = []; this._aabb = new AABB(); this._version = 0; }
  get_surface_count() { return this._surfaces.length; }
  surface_get_arrays(i) { return this._surfaces[i].arrays; }
  surface_get_material(i) { return this._surfaces[i] ? this._surfaces[i].material : null; }
  surface_set_material(i, m) { this._surfaces[i].material = m; this.emit_changed(); }
  get_aabb() { return this._aabb.clone(); }
  _surfaces_ref() { return this._surfaces; }
  _set_surfaces(s) {
    this._surfaces = s; this._version++;
    let first = true; const mn = new Vector3(), mx = new Vector3();
    for (const surf of s) {
      const v = surf.arrays.vertex;
      for (let i = 0; i < v.length; i += 3) {
        if (first) { mn.set(v[i], v[i + 1], v[i + 2]); mx.copy(mn); first = false; continue; }
        if (v[i] < mn.x) mn.x = v[i]; if (v[i + 1] < mn.y) mn.y = v[i + 1]; if (v[i + 2] < mn.z) mn.z = v[i + 2];
        if (v[i] > mx.x) mx.x = v[i]; if (v[i + 1] > mx.y) mx.y = v[i + 1]; if (v[i + 2] > mx.z) mx.z = v[i + 2];
      }
    }
    this._aabb = new AABB(mn, mx.sub(mn));
    GPUCache.release_all(this);
    this.emit_changed();
  }
  dispose() { GPUCache.release_all(this); super.dispose(); }
}
ClassDB.register(Mesh, 'Mesh', [], { abstract: true });

class ArrayMesh extends Mesh {
  // arrays: { vertex: Float32Array(xyz), normal?, tex_uv?, color?(rgba), index?: Uint16Array|Uint32Array }
  add_surface_from_arrays(primitive, arrays, material = null) {
    const a = {};
    if (!arrays.vertex || arrays.vertex.length % 3) throw new RangeError('add_surface_from_arrays: vertex array must be xyz floats');
    a.vertex = arrays.vertex instanceof Float32Array ? arrays.vertex : new Float32Array(arrays.vertex);
    const nv = a.vertex.length / 3;
    const chk = (name, comps, Ctor = Float32Array) => {
      if (!arrays[name]) return;
      const v = arrays[name] instanceof Ctor ? arrays[name] : new Ctor(arrays[name]);
      if (v.length !== nv * comps) throw new RangeError(`add_surface_from_arrays: ${name} has ${v.length / comps} elements, expected ${nv}`);
      a[name] = v;
    };
    chk('normal', 3); chk('tex_uv', 2); chk('color', 4);
    if (arrays.index) {
      const idx = arrays.index; let max = 0; for (let i = 0; i < idx.length; i++) if (idx[i] > max) max = idx[i];
      if (max >= nv) throw new RangeError('add_surface_from_arrays: index out of range');
      a.index = idx instanceof Uint16Array || idx instanceof Uint32Array ? idx : (max > 65535 ? new Uint32Array(idx) : new Uint16Array(idx));
    }
    this._set_surfaces(this._surfaces.concat([{ primitive, arrays: a, material }]));
    return this._surfaces.length - 1;
  }
  clear_surfaces() { this._set_surfaces([]); }
  get surfaces_data() { return this._surfaces.map((s) => ({ primitive: s.primitive, arrays: s.arrays, material: s.material })); }
  set surfaces_data(list) { this._set_surfaces(list.map((s) => ({ primitive: s.primitive, arrays: s.arrays, material: s.material || null }))); }
}
ClassDB.register(ArrayMesh, 'ArrayMesh', [{ name: 'surfaces_data', type: 'Array' }]);

// Primitive meshes regenerate when a property changes. Defaults follow the Godot class reference.
class PrimitiveMesh extends Mesh {
  constructor() { super(); this.material = null; this._dirty = true; }
  _p(name, v) { this['_' + name] = v; this._dirty = true; this._version++; GPUCache.release_all(this); }
  _ensure() { if (this._dirty) { this._dirty = false; const a = this._build(); this._set_surfaces([{ primitive: PrimitiveType.PRIMITIVE_TRIANGLES, arrays: a, material: null }]); } }
  get_surface_count() { this._ensure(); return 1; }
  surface_get_arrays(i) { this._ensure(); return super.surface_get_arrays(i); }
  surface_get_material() { return this.material; }
  get_aabb() { this._ensure(); return super.get_aabb(); }
  _surfaces_ref() { this._ensure(); return this._surfaces; }
}
ClassDB.register(PrimitiveMesh, 'PrimitiveMesh', [{ name: 'material', type: 'Resource' }], { abstract: true });
const _pushQuad = (P, N, U, I, o, du, dv, n) => { // o: corner, du/dv: edge vectors (counter-clockwise when viewed from n)
  const b = P.length / 3;
  const c = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const [s, t] of c) { P.push(o[0] + du[0] * s + dv[0] * t, o[1] + du[1] * s + dv[1] * t, o[2] + du[2] * s + dv[2] * t); N.push(n[0], n[1], n[2]); U.push(s, 1 - t); }
  I.push(b, b + 1, b + 2, b, b + 2, b + 3);
};
class BoxMesh extends PrimitiveMesh {
  constructor() { super(); this._size = new Vector3(1, 1, 1); }
  get size() { return this._size.clone(); } set size(v) { this._p('size', v.clone()); }
  _build() {
    const P = [], N = [], U = [], I = []; const x = this._size.x / 2, y = this._size.y / 2, z = this._size.z / 2;
    _pushQuad(P, N, U, I, [-x, -y, z], [2 * x, 0, 0], [0, 2 * y, 0], [0, 0, 1]);
    _pushQuad(P, N, U, I, [x, -y, -z], [-2 * x, 0, 0], [0, 2 * y, 0], [0, 0, -1]);
    _pushQuad(P, N, U, I, [x, -y, z], [0, 0, -2 * z], [0, 2 * y, 0], [1, 0, 0]);
    _pushQuad(P, N, U, I, [-x, -y, -z], [0, 0, 2 * z], [0, 2 * y, 0], [-1, 0, 0]);
    _pushQuad(P, N, U, I, [-x, y, z], [2 * x, 0, 0], [0, 0, -2 * z], [0, 1, 0]);
    _pushQuad(P, N, U, I, [-x, -y, -z], [2 * x, 0, 0], [0, 0, 2 * z], [0, -1, 0]);
    return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: new Uint16Array(I) };
  }
}
ClassDB.register(BoxMesh, 'BoxMesh', [{ name: 'size', type: 'Vector3' }]);
class PlaneMesh extends PrimitiveMesh { // faces +Y by default (Godot PlaneMesh orientation FACE_Y)
  constructor() { super(); this._size = new Vector2(2, 2); }
  get size() { return this._size.clone(); } set size(v) { this._p('size', v.clone()); }
  _build() { const P = [], N = [], U = [], I = []; const x = this._size.x / 2, z = this._size.y / 2; _pushQuad(P, N, U, I, [-x, 0, z], [2 * x, 0, 0], [0, 0, -2 * z], [0, 1, 0]); return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: new Uint16Array(I) }; }
}
ClassDB.register(PlaneMesh, 'PlaneMesh', [{ name: 'size', type: 'Vector2' }]);
class QuadMesh extends PrimitiveMesh { // faces +Z
  constructor() { super(); this._size = new Vector2(1, 1); }
  get size() { return this._size.clone(); } set size(v) { this._p('size', v.clone()); }
  _build() { const P = [], N = [], U = [], I = []; const x = this._size.x / 2, y = this._size.y / 2; _pushQuad(P, N, U, I, [-x, -y, 0], [2 * x, 0, 0], [0, 2 * y, 0], [0, 0, 1]); return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: new Uint16Array(I) }; }
}
ClassDB.register(QuadMesh, 'QuadMesh', [{ name: 'size', type: 'Vector2' }]);
class SphereMesh extends PrimitiveMesh {
  constructor() { super(); this._radius = 0.5; this._height = 1; this._radial_segments = 64; this._rings = 32; }
  get radius() { return this._radius; } set radius(v) { this._p('radius', v); }
  get height() { return this._height; } set height(v) { this._p('height', v); }
  get radial_segments() { return this._radial_segments; } set radial_segments(v) { this._p('radial_segments', Math.max(4, v | 0)); }
  get rings() { return this._rings; } set rings(v) { this._p('rings', Math.max(1, v | 0)); }
  _build() {
    const P = [], N = [], U = [], I = []; const R = this._radial_segments, RG = this._rings + 1, r = this._radius, hh = this._height / 2;
    for (let j = 0; j <= RG; j++) {
      const v = j / RG, phi = v * Math.PI; const y = Math.cos(phi), s = Math.sin(phi);
      for (let i = 0; i <= R; i++) {
        const u = i / R, th = u * Math.PI * 2; const x = -Math.sin(th) * s, z = -Math.cos(th) * s;
        P.push(x * r, y * hh, z * r); const n = new Vector3(x * r, y * hh, z * r).normalized(); N.push(n.x, n.y, n.z); U.push(u, v);
      }
    }
    for (let j = 0; j < RG; j++) for (let i = 0; i < R; i++) { const a = j * (R + 1) + i, b = a + R + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    const idx = P.length / 3 > 65535 ? new Uint32Array(I) : new Uint16Array(I);
    return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: idx };
  }
}
ClassDB.register(SphereMesh, 'SphereMesh', [{ name: 'radius', type: 'float' }, { name: 'height', type: 'float' }, { name: 'radial_segments', type: 'int' }, { name: 'rings', type: 'int' }]);
class CylinderMesh extends PrimitiveMesh {
  constructor() { super(); this._top_radius = 0.5; this._bottom_radius = 0.5; this._height = 2; this._radial_segments = 64; }
  get top_radius() { return this._top_radius; } set top_radius(v) { this._p('top_radius', v); }
  get bottom_radius() { return this._bottom_radius; } set bottom_radius(v) { this._p('bottom_radius', v); }
  get height() { return this._height; } set height(v) { this._p('height', v); }
  get radial_segments() { return this._radial_segments; } set radial_segments(v) { this._p('radial_segments', Math.max(3, v | 0)); }
  _build() {
    const P = [], N = [], U = [], I = []; const R = this._radial_segments, h = this._height / 2, rt = this._top_radius, rb = this._bottom_radius;
    const slope = (rb - rt) / this._height;
    for (let i = 0; i <= R; i++) {
      const u = i / R, th = u * Math.PI * 2, x = -Math.sin(th), z = -Math.cos(th); const n = new Vector3(x, slope, z).normalized();
      P.push(x * rt, h, z * rt, x * rb, -h, z * rb); N.push(n.x, n.y, n.z, n.x, n.y, n.z); U.push(u, 0, u, 1);
    }
    for (let i = 0; i < R; i++) { const a = i * 2; I.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    for (const [y, r, ny] of [[h, rt, 1], [-h, rb, -1]]) {
      if (r <= 0) continue; const c = P.length / 3; P.push(0, y, 0); N.push(0, ny, 0); U.push(0.5, 0.5);
      for (let i = 0; i <= R; i++) { const th = (i / R) * Math.PI * 2, x = -Math.sin(th), z = -Math.cos(th); P.push(x * r, y, z * r); N.push(0, ny, 0); U.push(0.5 + x * 0.5, 0.5 + z * 0.5); }
      for (let i = 0; i < R; i++) { if (ny > 0) I.push(c, c + 1 + i, c + 2 + i); else I.push(c, c + 2 + i, c + 1 + i); }
    }
    return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: new Uint16Array(I) };
  }
}
ClassDB.register(CylinderMesh, 'CylinderMesh', [{ name: 'top_radius', type: 'float' }, { name: 'bottom_radius', type: 'float' }, { name: 'height', type: 'float' }, { name: 'radial_segments', type: 'int' }]);
class CapsuleMesh extends PrimitiveMesh { // height is total height including caps (Godot 4)
  constructor() { super(); this._radius = 0.5; this._height = 2; this._radial_segments = 64; this._rings = 8; }
  get radius() { return this._radius; } set radius(v) { this._p('radius', v); }
  get height() { return this._height; } set height(v) { this._p('height', v); }
  get radial_segments() { return this._radial_segments; } set radial_segments(v) { this._p('radial_segments', Math.max(4, v | 0)); }
  get rings() { return this._rings; } set rings(v) { this._p('rings', Math.max(1, v | 0)); }
  _build() {
    const P = [], N = [], U = [], I = []; const R = this._radial_segments, r = this._radius, half = Math.max(0, this._height / 2 - r), RG = this._rings + 1;
    const rows = [];
    for (let j = 0; j <= RG; j++) rows.push([Math.PI / 2 * (1 - j / RG), half]);   // top hemisphere: angle from equator
    for (let j = 0; j <= RG; j++) rows.push([-Math.PI / 2 * (j / RG), -half]);      // bottom hemisphere
    rows.forEach(([lat, off], j) => {
      const y = Math.sin(lat), s = Math.cos(lat);
      for (let i = 0; i <= R; i++) { const th = (i / R) * Math.PI * 2, x = -Math.sin(th) * s, z = -Math.cos(th) * s; P.push(x * r, y * r + off, z * r); N.push(x, y, z); U.push(i / R, j / (rows.length - 1)); }
    });
    for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < R; i++) { const a = j * (R + 1) + i, b = a + R + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    return { vertex: new Float32Array(P), normal: new Float32Array(N), tex_uv: new Float32Array(U), index: new Uint16Array(I) };
  }
}
ClassDB.register(CapsuleMesh, 'CapsuleMesh', [{ name: 'radius', type: 'float' }, { name: 'height', type: 'float' }, { name: 'radial_segments', type: 'int' }, { name: 'rings', type: 'int' }]);

// ── Materials
const ShadingMode = Object.freeze({ SHADING_MODE_UNSHADED: 0, SHADING_MODE_PER_PIXEL: 1 });
const Transparency = Object.freeze({ TRANSPARENCY_DISABLED: 0, TRANSPARENCY_ALPHA: 1 });
const CullMode = Object.freeze({ CULL_BACK: 0, CULL_FRONT: 1, CULL_DISABLED: 2 });
class Material extends Resource { constructor() { super(); this.render_priority = 0; } }
ClassDB.register(Material, 'Material', [{ name: 'render_priority', type: 'int' }], { abstract: true });
class StandardMaterial3D extends Material {
  constructor() {
    super();
    this.albedo_color = new Color(1, 1, 1, 1); this.albedo_texture = null;
    this.metallic = 0; this.roughness = 1; this.metallic_specular = 0.5;
    this.emission_enabled = false; this.emission = new Color(0, 0, 0, 1); this.emission_energy_multiplier = 1;
    this.shading_mode = ShadingMode.SHADING_MODE_PER_PIXEL; this.transparency = Transparency.TRANSPARENCY_DISABLED;
    this.cull_mode = CullMode.CULL_BACK; this.vertex_color_use_as_albedo = false; this.uv1_scale = new Vector3(1, 1, 1);
    this.no_depth_test = false;
  }
}
ClassDB.register(StandardMaterial3D, 'StandardMaterial3D', [
  { name: 'albedo_color', type: 'Color' }, { name: 'albedo_texture', type: 'Resource' }, { name: 'metallic', type: 'float' },
  { name: 'roughness', type: 'float' }, { name: 'metallic_specular', type: 'float' }, { name: 'emission_enabled', type: 'bool' },
  { name: 'emission', type: 'Color' }, { name: 'emission_energy_multiplier', type: 'float' }, { name: 'shading_mode', type: 'int' },
  { name: 'transparency', type: 'int' }, { name: 'cull_mode', type: 'int' }, { name: 'vertex_color_use_as_albedo', type: 'bool' }, { name: 'uv1_scale', type: 'Vector3' },
]);
// ShaderMaterial: user GLSL ES 3.00 fragment body; inputs v_world, v_normal, v_uv, v_color; must set `vec4 COLOR` (linear RGB + alpha).
// Uniforms declared in `uniforms` are set from shader_parameters (float/vec2/vec3/vec4/Color).
class ShaderMaterial extends Material {
  constructor() { super(); this.code = ''; this.uniforms = ''; this._params = new Map(); this._version = 0; this.cull_mode = CullMode.CULL_BACK; this.transparency = Transparency.TRANSPARENCY_DISABLED; }
  set_code(fragment_body, uniform_decls = '') { this.code = fragment_body; this.uniforms = uniform_decls; this._version++; this.emit_changed(); }
  set_shader_parameter(n, v) { this._params.set(n, v); }
  get_shader_parameter(n) { return this._params.get(n); }
}
ClassDB.register(ShaderMaterial, 'ShaderMaterial', [{ name: 'code', type: 'string' }, { name: 'uniforms', type: 'string' }]);

class Environment extends Resource {
  constructor() { super(); this.background_mode = 0; this.background_color = new Color(0.3, 0.3, 0.3, 1); this.ambient_light_color = new Color(0, 0, 0, 1); this.ambient_light_energy = 1; }
}
Environment.BG_CLEAR_COLOR = 0; Environment.BG_COLOR = 1;
ClassDB.register(Environment, 'Environment', [{ name: 'background_mode', type: 'int' }, { name: 'background_color', type: 'Color' }, { name: 'ambient_light_color', type: 'Color' }, { name: 'ambient_light_energy', type: 'float' }]);

const RenderingServer = {
  _default_clear_color: new Color(0.3, 0.3, 0.3, 1), // Godot default_clear_color
  set_default_clear_color(c) { this._default_clear_color = c.clone(); },
  get_default_clear_color() { return this._default_clear_color.clone(); },
  directional_shadow_size: 2048,
};

// ── World3D registry per Viewport
class World3D {
  constructor() { this.instances = new Set(); this.lights = new Set(); this.cameras = new Set(); this.environments = []; this.particles = new Set(); }
}
const _world_of = (node) => { const vp = node.get_viewport(); if (!vp) return null; return vp._world_3d || (vp._world_3d = new World3D()); };

class VisualInstance3D extends Node3D {
  constructor(name) { super(name); this.layers = 1; this._world = null; this._waabb = new AABB(); this._waabb_ver = -1; }
  get_aabb() { return new AABB(); }
  _register(w) {} _unregister(w) {}
  _on_enter_tree_internal() { super._on_enter_tree_internal(); this._world = _world_of(this); if (this._world) this._register(this._world); }
  _on_exit_tree_internal() { if (this._world) this._unregister(this._world); this._world = null; }
  _content_version() { return 0; }
  get_world_aabb() {
    const g = this._global_ref(); const cv = this._content_version();
    if (this._waabb_ver !== this._gver || this._waabb_cv !== cv || this._gdirty_local_aabb) { this.get_aabb().xformed(g, this._waabb); this._waabb_ver = this._gver; this._waabb_cv = cv; this._gdirty_local_aabb = false; }
    return this._waabb;
  }
}
ClassDB.register(VisualInstance3D, 'VisualInstance3D', [{ name: 'layers', type: 'int' }], { abstract: true });
const ShadowCasting = Object.freeze({ SHADOW_CASTING_SETTING_OFF: 0, SHADOW_CASTING_SETTING_ON: 1, SHADOW_CASTING_SETTING_DOUBLE_SIDED: 2, SHADOW_CASTING_SETTING_SHADOWS_ONLY: 3 });
class GeometryInstance3D extends VisualInstance3D {
  constructor(name) { super(name); this.material_override = null; this.cast_shadow = ShadowCasting.SHADOW_CASTING_SETTING_ON; this.instance_color = new Color(1, 1, 1, 1); }
  _register(w) { w.instances.add(this); } _unregister(w) { w.instances.delete(this); }
}
ClassDB.register(GeometryInstance3D, 'GeometryInstance3D', [{ name: 'material_override', type: 'Resource' }, { name: 'cast_shadow', type: 'int' }], { abstract: true });
class MeshInstance3D extends GeometryInstance3D {
  constructor(name) { super(name); this._mesh = null; this._surface_override = []; }
  get mesh() { return this._mesh; } set mesh(m) { this._mesh = m; this._gdirty_local_aabb = true; }
  get_aabb() { return this._mesh ? this._mesh.get_aabb() : new AABB(); }
  _content_version() { return this._mesh ? this._mesh._version : 0; }
  set_surface_override_material(i, m) { this._surface_override[i] = m; }
  get_surface_override_material(i) { return this._surface_override[i] || null; }
  get_active_material(i) { return this.material_override || this._surface_override[i] || (this._mesh ? this._mesh.surface_get_material(i) : null); }
}
ClassDB.register(MeshInstance3D, 'MeshInstance3D', [{ name: 'mesh', type: 'Resource' }]);

class MultiMesh extends Resource {
  constructor() { super(); this.mesh = null; this.use_colors = false; this._count = 0; this._xf = new Float32Array(0); this._col = new Float32Array(0); this.visible_instance_count = -1; this._aabb = null; }
  get instance_count() { return this._count; }
  set instance_count(n) {
    n = Math.max(0, n | 0); this._count = n; this._xf = new Float32Array(n * 16); this._col = new Float32Array(n * 4).fill(1);
    for (let i = 0; i < n; i++) { this._xf[i * 16] = this._xf[i * 16 + 5] = this._xf[i * 16 + 10] = this._xf[i * 16 + 15] = 1; }
    this._aabb = null;
  }
  set_instance_transform(i, t) { if (i < 0 || i >= this._count) { Log.error('MultiMesh: index out of range', i); return; } Mat4.from_transform3d(t, this._xf.subarray(i * 16, i * 16 + 16)); this._aabb = null; }
  get_instance_transform(i) { const m = this._xf, o = i * 16; return new Transform3D(new Basis(new Vector3(m[o], m[o + 1], m[o + 2]), new Vector3(m[o + 4], m[o + 5], m[o + 6]), new Vector3(m[o + 8], m[o + 9], m[o + 10])), new Vector3(m[o + 12], m[o + 13], m[o + 14])); }
  set_instance_color(i, c) { if (!this.use_colors) Log.warn('MultiMesh.set_instance_color: use_colors is false'); const o = i * 4; this._col[o] = c.r; this._col[o + 1] = c.g; this._col[o + 2] = c.b; this._col[o + 3] = c.a; }
  get_aabb() {
    if (this._aabb) return this._aabb;
    const n = this.visible_instance_count < 0 ? this._count : Math.min(this._count, this.visible_instance_count);
    if (!this.mesh || !n) return (this._aabb = new AABB());
    const local = this.mesh.get_aabb(); let acc = null; const tmp = new AABB();
    for (let i = 0; i < n; i++) { local.xformed(this.get_instance_transform(i), tmp); acc = acc ? acc.merge(tmp) : tmp.clone(); }
    return (this._aabb = acc);
  }
}
ClassDB.register(MultiMesh, 'MultiMesh', [{ name: 'mesh', type: 'Resource' }, { name: 'use_colors', type: 'bool' }, { name: 'instance_count', type: 'int' }]);
class MultiMeshInstance3D extends GeometryInstance3D {
  constructor(name) { super(name); this.multimesh = null; }
  get_aabb() { return this.multimesh ? this.multimesh.get_aabb() : new AABB(); }
  get_world_aabb() { this._gdirty_local_aabb = true; return super.get_world_aabb(); }
}
ClassDB.register(MultiMeshInstance3D, 'MultiMeshInstance3D', [{ name: 'multimesh', type: 'Resource' }]);

class Light3D extends VisualInstance3D {
  constructor(name) { super(name); this.light_color = new Color(1, 1, 1, 1); this.light_energy = 1; this.light_specular = 0.5; this.shadow_enabled = false; this.shadow_bias = 0.1; this.shadow_normal_bias = 2.0; this.light_cull_mask = 0xFFFFFFFF; }
  _register(w) { w.lights.add(this); } _unregister(w) { w.lights.delete(this); }
}
ClassDB.register(Light3D, 'Light3D', [{ name: 'light_color', type: 'Color' }, { name: 'light_energy', type: 'float' }, { name: 'light_specular', type: 'float' }, { name: 'shadow_enabled', type: 'bool' }, { name: 'shadow_bias', type: 'float' }, { name: 'shadow_normal_bias', type: 'float' }], { abstract: true });
class DirectionalLight3D extends Light3D { constructor(name) { super(name); this.directional_shadow_max_distance = 100; } }
ClassDB.register(DirectionalLight3D, 'DirectionalLight3D', [{ name: 'directional_shadow_max_distance', type: 'float' }]);
class OmniLight3D extends Light3D { constructor(name) { super(name); this.omni_range = 5; this.omni_attenuation = 1; } }
ClassDB.register(OmniLight3D, 'OmniLight3D', [{ name: 'omni_range', type: 'float' }, { name: 'omni_attenuation', type: 'float' }]);
class SpotLight3D extends Light3D { constructor(name) { super(name); this.spot_range = 5; this.spot_attenuation = 1; this.spot_angle = 45; this.spot_angle_attenuation = 1; } }
ClassDB.register(SpotLight3D, 'SpotLight3D', [{ name: 'spot_range', type: 'float' }, { name: 'spot_attenuation', type: 'float' }, { name: 'spot_angle', type: 'float' }, { name: 'spot_angle_attenuation', type: 'float' }]);

class WorldEnvironment extends Node {
  constructor(name) { super(name); this.environment = null; }
  _on_enter_tree_internal() { const w = _world_of(this); if (w) w.environments.push(this); this._w = w; }
  _on_exit_tree_internal() { if (this._w) { const i = this._w.environments.indexOf(this); if (i >= 0) this._w.environments.splice(i, 1); } this._w = null; }
}
ClassDB.register(WorldEnvironment, 'WorldEnvironment', [{ name: 'environment', type: 'Resource' }]);

class Camera3D extends Node3D {
  constructor(name) { super(name); this.fov = 75; this.near = 0.05; this.far = 4000; this.projection = 0; this.size = 1; this.keep_aspect = 1; this._current = false; this.cull_mask = 0xFFFFF; this.environment = null; }
  get current() { return this._current; }
  set current(v) { v = !!v; if (v) this.make_current(); else this.clear_current(); }
  make_current() {
    this._current = true; const vp = this.get_viewport();
    if (vp) { if (vp._camera_3d && vp._camera_3d !== this) vp._camera_3d._current = false; vp._camera_3d = this; }
  }
  clear_current(enable_next = true) {
    this._current = false; const vp = this.get_viewport();
    if (vp && vp._camera_3d === this) { vp._camera_3d = null; if (enable_next) { for (const c of vp._cameras_3d) if (c !== this) { c.make_current(); break; } } }
  }
  is_current() { return this._current && !!this._tree; }
  _on_enter_tree_internal() {
    super._on_enter_tree_internal(); const vp = this.get_viewport(); if (!vp) return;
    vp._cameras_3d.add(this);
    if (this._current || !vp._camera_3d) this.make_current(); // first camera becomes current (Godot behavior)
  }
  _on_exit_tree_internal() {
    const vp = this.get_viewport(); if (!vp) return; vp._cameras_3d.delete(this);
    if (vp._camera_3d === this) { vp._camera_3d = null; for (const c of vp._cameras_3d) { c.make_current(); break; } this._current = true; }
  }
  get_projection_matrix(aspect, out = new Float32Array(16)) {
    if (this.projection === 1) { const h = this.size / 2, w = h * aspect; return Mat4.orthographic(-w, w, -h, h, this.near, this.far, out); }
    return Mat4.perspective(this.fov, aspect, this.near, this.far, out);
  }
  get_camera_transform() { return this.global_transform; }
  _aspect() { const vp = this.get_viewport(); return vp ? vp._size.x / Math.max(1, vp._size.y) : 1; }
  project_ray_origin(p) { if (this.projection === 1) return this._ortho_point(p); return this.global_position; }
  _ndc(p) { const vp = this.get_viewport(); const s = vp ? vp._size : new Vector2(1, 1); return new Vector2((p.x / s.x) * 2 - 1, 1 - (p.y / s.y) * 2); }
  _ortho_point(p) { const n = this._ndc(p); const h = this.size / 2, w = h * this._aspect(); return this.global_transform.xform(new Vector3(n.x * w, n.y * h, -this.near)); }
  project_ray_normal(p) {
    if (this.projection === 1) return this.global_basis.xform(Vector3.FORWARD).normalized();
    const n = this._ndc(p); const t = Math.tan(MathUtil.deg_to_rad(this.fov) / 2);
    return this.global_basis.xform(new Vector3(n.x * t * this._aspect(), n.y * t, -1)).normalized();
  }
  project_position(p, z) { return this.project_ray_origin(p).add(this.project_ray_normal(p).mul(z)); }
  unproject_position(world) {
    const vp = this.get_viewport(); const s = vp ? vp._size : new Vector2(1, 1);
    const view = this.global_transform.affine_inverse().xform(world);
    const P = this.get_projection_matrix(this._aspect());
    const cx = P[0] * view.x + P[4] * view.y + P[8] * view.z + P[12], cy = P[1] * view.x + P[5] * view.y + P[9] * view.z + P[13], cw = P[3] * view.x + P[7] * view.y + P[11] * view.z + P[15];
    return new Vector2((cx / cw * 0.5 + 0.5) * s.x, (1 - (cy / cw * 0.5 + 0.5)) * s.y);
  }
  is_position_behind(world) { return this.global_basis.xform(Vector3.FORWARD).dot(world.sub(this.global_position)) < 0; }
}
Camera3D.PROJECTION_PERSPECTIVE = 0; Camera3D.PROJECTION_ORTHOGONAL = 1;
ClassDB.register(Camera3D, 'Camera3D', [{ name: 'fov', type: 'float' }, { name: 'near', type: 'float' }, { name: 'far', type: 'float' }, { name: 'projection', type: 'int' }, { name: 'size', type: 'float' }, { name: 'current', type: 'bool' }]);

// ── 2D nodes
class Sprite2D extends Node2D {
  constructor(name) { super(name); this.texture = null; this.centered = true; this.offset = new Vector2(); this.flip_h = false; this.flip_v = false; this.region_enabled = false; this.region_rect = new Rect2(); this.hframes = 1; this.vframes = 1; this.frame = 0; }
  get_rect() {
    if (!this.texture) return new Rect2();
    let w = this.region_enabled ? this.region_rect.size.x : this.texture.get_width(), h = this.region_enabled ? this.region_rect.size.y : this.texture.get_height();
    w /= this.hframes; h /= this.vframes;
    const o = this.offset.clone(); if (this.centered) { o.x -= w / 2; o.y -= h / 2; }
    return new Rect2(o.x, o.y, w, h);
  }
  _source_uv() {
    const tw = this.texture.get_width(), th = this.texture.get_height();
    let x = 0, y = 0, w = tw, h = th; if (this.region_enabled) { x = this.region_rect.position.x; y = this.region_rect.position.y; w = this.region_rect.size.x; h = this.region_rect.size.y; }
    const fw = w / this.hframes, fh = h / this.vframes; const fx = this.frame % this.hframes, fy = Math.floor(this.frame / this.hframes);
    let u0 = (x + fx * fw) / tw, v0 = (y + fy * fh) / th, u1 = u0 + fw / tw, v1 = v0 + fh / th;
    if (this.flip_h) { const t = u0; u0 = u1; u1 = t; } if (this.flip_v) { const t = v0; v0 = v1; v1 = t; }
    return [u0, v0, u1, v1];
  }
}
ClassDB.register(Sprite2D, 'Sprite2D', [{ name: 'texture', type: 'Resource' }, { name: 'centered', type: 'bool' }, { name: 'offset', type: 'Vector2' }, { name: 'flip_h', type: 'bool' }, { name: 'flip_v', type: 'bool' }, { name: 'region_enabled', type: 'bool' }, { name: 'region_rect', type: 'Rect2' }, { name: 'hframes', type: 'int' }, { name: 'vframes', type: 'int' }, { name: 'frame', type: 'int' }]);

class Camera2D extends Node2D {
  constructor(name) { super(name); this.offset = new Vector2(); this.zoom = new Vector2(1, 1); this.anchor_mode = 1; this.enabled = true; this.ignore_rotation = true; }
  make_current() { const vp = this.get_viewport(); if (vp) vp._camera_2d = this; }
  is_current() { const vp = this.get_viewport(); return !!vp && vp._camera_2d === this; }
  _on_enter_tree_internal() { super._on_enter_tree_internal(); const vp = this.get_viewport(); if (vp) { vp._cameras_2d.add(this); if (!vp._camera_2d && this.enabled) vp._camera_2d = this; } }
  _on_exit_tree_internal() { const vp = this.get_viewport(); if (vp) { vp._cameras_2d.delete(this); if (vp._camera_2d === this) { vp._camera_2d = null; for (const c of vp._cameras_2d) { if (c.enabled) { vp._camera_2d = c; break; } } } } }
  // canvas = S(zoom) * R(-rot) * T(-camera) then + anchor offset
  get_canvas_transform(vp_size) {
    const g = this.get_global_transform(); const pos = g.origin.add(this.offset);
    const rot = this.ignore_rotation ? 0 : g.get_rotation();
    const c = Math.cos(-rot), s = Math.sin(-rot), zx = this.zoom.x, zy = this.zoom.y;
    const t = new Transform2D(new Vector2(c * zx, s * zy), new Vector2(-s * zx, c * zy));
    const anchor = this.anchor_mode === 1 ? vp_size.mul(0.5) : new Vector2();
    t.origin = anchor.sub(t.basis_xform(pos));
    return t;
  }
  get_screen_center_position() { return this.get_global_transform().origin.add(this.offset); }
}
Camera2D.ANCHOR_MODE_FIXED_TOP_LEFT = 0; Camera2D.ANCHOR_MODE_DRAG_CENTER = 1;
ClassDB.register(Camera2D, 'Camera2D', [{ name: 'offset', type: 'Vector2' }, { name: 'zoom', type: 'Vector2' }, { name: 'anchor_mode', type: 'int' }, { name: 'enabled', type: 'bool' }]);

// Render list: backend-agnostic snapshot of what to draw this frame.
const _frustum = [new Plane(), new Plane(), new Plane(), new Plane(), new Plane(), new Plane()];
function aabb_in_frustum(aabb, planes) {
  const p = aabb.position, s = aabb.size;
  for (let i = 0; i < 6; i++) {
    const n = planes[i].normal; // positive vertex test
    const x = n.x >= 0 ? p.x + s.x : p.x, y = n.y >= 0 ? p.y + s.y : p.y, z = n.z >= 0 ? p.z + s.z : p.z;
    if (n.x * x + n.y * y + n.z * z < planes[i].d) return false;
  }
  return true;
}
function extract_render_list(vp, aspect, stats) {
  const cam = vp._camera_3d && vp._camera_3d._tree ? vp._camera_3d : null;
  const w = vp._world_3d;
  const out = { camera: cam, view: null, proj: null, view_proj: null, cam_pos: null, items: [], casters: [], lights: [], env: null, clear: RenderingServer._default_clear_color };
  if (w && w.environments.length) { const e = w.environments[0].environment; if (e) out.env = e; }
  if (cam && cam.environment) out.env = cam.environment;
  if (out.env && out.env.background_mode === Environment.BG_COLOR) out.clear = out.env.background_color;
  if (!cam || !w) return out;
  const camT = cam._global_ref();
  out.view = Mat4.from_transform3d(camT.affine_inverse()); out.proj = cam.get_projection_matrix(aspect); out.view_proj = Mat4.multiply(out.proj, out.view);
  out.cam_pos = camT.origin.clone();
  Mat4.frustum_planes(out.view_proj, _frustum);
  for (const inst of w.instances) {
    if (!inst.is_visible_in_tree() || !(inst.layers & cam.cull_mask)) continue;
    const isMM = inst instanceof MultiMeshInstance3D;
    const mesh = isMM ? (inst.multimesh && inst.multimesh.mesh) : inst.mesh;
    if (!mesh) continue;
    const wa = inst.get_world_aabb();
    const visible = aabb_in_frustum(wa, _frustum);
    if (inst.cast_shadow !== ShadowCasting.SHADOW_CASTING_SETTING_OFF) out.casters.push(inst);
    if (!visible) { stats.frame.culled++; continue; }
    if (inst.cast_shadow === ShadowCasting.SHADOW_CASTING_SETTING_SHADOWS_ONLY) continue;
    out.items.push(inst);
  }
  for (const l of w.lights) if (l.is_visible_in_tree()) out.lights.push(l);
  // Directional lights first so the shadowed one gets slot 0.
  out.lights.sort((a, b) => (b instanceof DirectionalLight3D) - (a instanceof DirectionalLight3D) || (b.shadow_enabled - a.shadow_enabled));
  stats.frame.objects += out.items.length;
  return out;
}

// Collect 2D draw items in tree order, stable-sorted by effective z.
function extract_canvas_items(tree) {
  tree._ensure_order(); const items = [];
  for (const n of tree._order) if (n instanceof CanvasItem && n._visible && n.is_visible_in_tree()) items.push(n);
  if (items.some((n) => n._z_index !== 0 || n._parent instanceof CanvasItem && n._parent._z_index !== 0)) {
    const z = new Map(); for (const n of items) z.set(n, n._effective_z());
    items.sort((a, b) => z.get(a) - z.get(b) || a._tree_index - b._tree_index);
  }
  return items;
}

// ── WebGL2 backend
const ATTR = { POSITION: 0, NORMAL: 1, UV: 2, COLOR: 3, INST_MODEL: 4, INST_COLOR: 8 };
const INSTANCE_FLOATS = 20; // mat4 + color
class WebGL2Backend {
  constructor(canvas, opts = {}) {
    const attrs = Object.assign({ antialias: false, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: !!opts.preserve_drawing_buffer, premultipliedAlpha: false, powerPreference: 'high-performance' }, opts.context_attributes || {});
    const gl = canvas.getContext('webgl2', attrs);
    if (!gl) throw new Error('WebGL2 is not available');
    this.name = 'webgl2'; this.canvas = canvas; this.gl = gl; this.gen = 1; this.lost = false; this.stats = new GPUStats();
    this._tracked = new Set(); this._owners = new Set(); this._lost_cbs = new Set(); this._restored_cbs = new Set(); this.disposed = false;
    this._onLost = (e) => {
      e.preventDefault(); // required so the browser may restore the context
      this.lost = true; this._tracked.clear(); this._owners.clear(); const f = this.stats.frame; this.stats.reset_all(); Object.assign(this.stats.frame, f);
      Log.warn('WebGL2 context lost; rendering suspended until restored');
      for (const cb of this._lost_cbs) cb();
    };
    this._onRestored = () => {
      this.lost = false; this.gen++;
      Log.print('WebGL2 context restored; GPU resources will be recreated from CPU-side data');
      this._init_state();
      for (const cb of this._restored_cbs) cb();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    this._init_state();
    _liveBackends.add(this);
  }
  _init_state() {
    const gl = this.gl;
    gl.vertexAttrib3f(ATTR.NORMAL, 0, 0, 1); gl.vertexAttrib2f(ATTR.UV, 0, 0); gl.vertexAttrib4f(ATTR.COLOR, 1, 1, 1, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }
  on_context_lost(cb) { this._lost_cbs.add(cb); } on_context_restored(cb) { this._restored_cbs.add(cb); }
  _check(label) {
    if (!Config.debug) return;
    const e = this.gl.getError(); if (e !== this.gl.NO_ERROR && !this.lost) Log.error(`GL error 0x${e.toString(16)} in ${label}`);
  }
  _track(type, h, bytes = 0) {
    const w = { type, h, bytes, gen: this.gen, alive: true };
    this._tracked.add(w); this.stats.counts[type]++;
    if (type === 'buffer' || type === 'texture') this.stats.bytes[type] += bytes;
    return w;
  }
  _untrack(w) {
    if (!w || !w.alive) return false; w.alive = false;
    if (w.gen !== this.gen) return false; // object died with a lost context
    this._tracked.delete(w); this.stats.counts[w.type]--;
    if (w.type === 'buffer' || w.type === 'texture') this.stats.bytes[w.type] -= w.bytes;
    return true;
  }
  // Buffers
  create_buffer(target, data, usage) {
    const gl = this.gl; const h = gl.createBuffer(); gl.bindBuffer(target, h);
    gl.bufferData(target, data, usage || gl.STATIC_DRAW); this._check('create_buffer');
    const w = this._track('buffer', h, data.byteLength !== undefined ? data.byteLength : data); w.target = target; w.usage = usage || gl.STATIC_DRAW; return w;
  }
  update_buffer(w, data) {
    const gl = this.gl; gl.bindBuffer(w.target, w.h);
    if (data.byteLength > w.bytes) { gl.bufferData(w.target, data, w.usage); this.stats.bytes.buffer += data.byteLength - w.bytes; w.bytes = data.byteLength; }
    else gl.bufferSubData(w.target, 0, data);
  }
  delete_buffer(w) { if (this._untrack(w)) this.gl.deleteBuffer(w.h); }
  create_vao() { const h = this.gl.createVertexArray(); return this._track('vao', h); }
  delete_vao(w) { if (this._untrack(w)) this.gl.deleteVertexArray(w.h); }
  // Textures. desc: {width,height,data?,format:'rgba8'|'srgba8'|'depth24', filter, mipmaps, repeat, compare}
  create_texture(desc) {
    const gl = this.gl; const h = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, h);
    let bpp = 4;
    if (desc.format === 'depth24') {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, desc.width, desc.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (desc.compare) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL); }
    } else {
      const internal = desc.format === 'srgba8' ? gl.SRGB8_ALPHA8 : gl.RGBA8;
      const levels = desc.mipmaps ? Math.floor(Math.log2(Math.max(desc.width, desc.height))) + 1 : 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, internal, desc.width, desc.height);
      if (desc.data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, desc.width, desc.height, gl.RGBA, gl.UNSIGNED_BYTE, desc.data);
      if (desc.mipmaps && desc.data) gl.generateMipmap(gl.TEXTURE_2D);
      const lin = desc.filter === undefined || desc.filter === TextureFilter.LINEAR || desc.filter === TextureFilter.LINEAR_WITH_MIPMAPS;
      const minf = desc.mipmaps ? (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : (lin ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minf); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      if (desc.mipmaps) bpp = 4 * 4 / 3;
    }
    const wrap = desc.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this._check('create_texture');
    const w = this._track('texture', h, Math.round(desc.width * desc.height * bpp)); w.width = desc.width; w.height = desc.height; w.format = desc.format; return w;
  }
  delete_texture(w) { if (this._untrack(w)) this.gl.deleteTexture(w.h); }
  create_renderbuffer(width, height, format) { const gl = this.gl; const h = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, h); gl.renderbufferStorage(gl.RENDERBUFFER, format || gl.DEPTH_COMPONENT24, width, height); return this._track('renderbuffer', h); }
  delete_renderbuffer(w) { if (this._untrack(w)) this.gl.deleteRenderbuffer(w.h); }
  // Framebuffer: {color?: textureWrapper, depth?: textureWrapper|renderbufferWrapper}
  create_framebuffer(att) {
    const gl = this.gl; const h = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, h);
    if (att.color) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, att.color.h, 0);
    else { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
    if (att.depth) {
      if (att.depth.type === 'texture') gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, att.depth.h, 0);
      else gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, att.depth.h);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) { gl.deleteFramebuffer(h); throw new Error('Framebuffer incomplete: 0x' + st.toString(16)); }
    const w = this._track('framebuffer', h); w.att = att; return w;
  }
  delete_framebuffer(w) { if (this._untrack(w)) this.gl.deleteFramebuffer(w.h); }
  // Render target = color texture + depth renderbuffer, for render-to-texture.
  create_render_target(width, height) {
    const color = this.create_texture({ width, height, format: 'rgba8', filter: TextureFilter.LINEAR });
    const depth = this.create_renderbuffer(width, height);
    const fb = this.create_framebuffer({ color, depth });
    return { fb, color, depth, width, height };
  }
  delete_render_target(rt) { this.delete_framebuffer(rt.fb); this.delete_texture(rt.color); this.delete_renderbuffer(rt.depth); }
  // Shaders with line-numbered error reporting.
  _compile(type, src, label) {
    const gl = this.gl; const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s) || ''; gl.deleteShader(s);
      const lines = src.split('\n'); const m = /ERROR:\s*\d+:(\d+)/.exec(log); const ln = m ? parseInt(m[1], 10) : -1;
      const ctx = ln > 0 ? lines.slice(Math.max(0, ln - 3), ln + 2).map((l, i) => `${String(Math.max(1, ln - 2) + i).padStart(4)}${Math.max(1, ln - 2) + i === ln ? '>' : '|'} ${l}`).join('\n') : '';
      const err = new ShaderCompileError(`${label} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader compile failed:\n${log.trim()}\n${ctx}`);
      err.line = ln; err.info_log = log; throw err;
    }
    return s;
  }
  create_program(vs, fs, label = 'program') {
    const gl = this.gl; const v = this._compile(gl.VERTEX_SHADER, vs, label);
    let f; try { f = this._compile(gl.FRAGMENT_SHADER, fs, label); } catch (e) { gl.deleteShader(v); throw e; }
    const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    gl.detachShader(p, v); gl.detachShader(p, f); gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) { const log = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new ShaderCompileError(`${label} link failed: ${log}`); }
    const w = this._track('program', p); w.uniforms = new Map(); w.label = label;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); w.uniforms.set(name, gl.getUniformLocation(p, info.name)); }
    return w;
  }
  delete_program(w) { if (this._untrack(w)) this.gl.deleteProgram(w.h); }
  release_entry(e) {
    for (const k of Object.keys(e)) {
      const w = e[k]; if (!w || typeof w !== 'object' || !w.type) continue;
      if (w.type === 'buffer') this.delete_buffer(w); else if (w.type === 'texture') this.delete_texture(w); else if (w.type === 'vao') this.delete_vao(w);
      else if (w.type === 'framebuffer') this.delete_framebuffer(w); else if (w.type === 'renderbuffer') this.delete_renderbuffer(w); else if (w.type === 'program') this.delete_program(w);
    }
    if (e.surfaces) for (const s of e.surfaces) this.release_entry(s);
  }
  read_pixels(x, y, w, h, fb = null) {
    const gl = this.gl; const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb ? fb.h : null);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return out;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const r of [...this._owners]) GPUCache.release(r, this);
    for (const w of [...this._tracked]) {
      const gl = this.gl; this._untrack(w);
      if (w.type === 'buffer') gl.deleteBuffer(w.h); else if (w.type === 'texture') gl.deleteTexture(w.h); else if (w.type === 'vao') gl.deleteVertexArray(w.h);
      else if (w.type === 'program') gl.deleteProgram(w.h); else if (w.type === 'framebuffer') gl.deleteFramebuffer(w.h); else if (w.type === 'renderbuffer') gl.deleteRenderbuffer(w.h);
    }
    this.canvas.removeEventListener('webglcontextlost', this._onLost); this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    _liveBackends.delete(this);
  }
}

// ── GLSL sources
const GLSL_COMMON = `#version 300 es
precision highp float;
precision highp int;
`;
const GLSL_MESH_VS = `
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec2 a_uv;
layout(location=3) in vec4 a_color;
layout(location=4) in mat4 a_model;
layout(location=8) in vec4 a_inst_color;
uniform mat4 u_view_proj;
uniform vec2 u_uv_scale;
#ifdef SHADOWS
uniform mat4 u_light_vp;
uniform float u_normal_bias;
out vec4 v_light_pos;
#endif
out vec3 v_world; out vec3 v_normal; out vec2 v_uv; out vec4 v_color;
void main() {
  vec4 w = a_model * vec4(a_position, 1.0);
  mat3 nm = transpose(inverse(mat3(a_model)));
  v_normal = normalize(nm * a_normal);
  v_world = w.xyz; v_uv = a_uv * u_uv_scale; v_color = a_color * a_inst_color;
#ifdef SHADOWS
  v_light_pos = u_light_vp * vec4(w.xyz + v_normal * u_normal_bias, 1.0);
#endif
  gl_Position = u_view_proj * w;
}`;
const GLSL_LIGHT_FS = `
#define PI 3.14159265359
in vec3 v_world; in vec3 v_normal; in vec2 v_uv; in vec4 v_color;
#ifdef SHADOWS
in vec4 v_light_pos;
uniform highp sampler2DShadow u_shadow_map;
uniform float u_shadow_texel;
uniform float u_shadow_bias;
#endif
out vec4 frag;
uniform vec4 u_albedo;
#ifdef ALBEDO_TEX
uniform sampler2D u_albedo_tex;
#endif
uniform float u_metallic; uniform float u_roughness; uniform float u_specular;
uniform vec3 u_emission; uniform vec3 u_camera_pos; uniform vec3 u_ambient;
uniform int u_light_count;
uniform vec4 u_lpos[MAX_LIGHTS];
uniform vec4 u_ldir[MAX_LIGHTS];
uniform vec4 u_lcolor[MAX_LIGHTS];
uniform vec4 u_lparams[MAX_LIGHTS];
vec3 linear_to_srgb(vec3 c) { return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
#ifdef SHADOWS
float shadow_factor() {
  vec3 p = v_light_pos.xyz / v_light_pos.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 1.0;
  float s = 0.0; float z = p.z - u_shadow_bias;
  s += texture(u_shadow_map, vec3(p.xy + vec2(-0.5, -0.5) * u_shadow_texel, z));
  s += texture(u_shadow_map, vec3(p.xy + vec2( 0.5, -0.5) * u_shadow_texel, z));
  s += texture(u_shadow_map, vec3(p.xy + vec2(-0.5,  0.5) * u_shadow_texel, z));
  s += texture(u_shadow_map, vec3(p.xy + vec2( 0.5,  0.5) * u_shadow_texel, z));
  return s * 0.25;
}
#endif
// Godot 4 distance attenuation: smooth range window times distance^-decay.
float omni_attenuation(float d, float inv_range, float decay) {
  float nd = d * inv_range; nd *= nd; nd *= nd; nd = max(1.0 - nd, 0.0); nd *= nd;
  return nd * pow(max(d, 0.0001), -decay);
}
void main() {
  vec4 albedo = u_albedo * v_color;
#ifdef ALBEDO_TEX
  albedo *= texture(u_albedo_tex, v_uv);
#endif
#ifdef UNSHADED
  vec3 col = albedo.rgb;
#else
  vec3 N = normalize(v_normal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(u_camera_pos - v_world);
  float rough = clamp(u_roughness, 0.04, 1.0); float a = rough * rough; float a2 = a * a;
  vec3 F0 = mix(vec3(0.16 * u_specular * u_specular), albedo.rgb, u_metallic);
  vec3 col = u_ambient * albedo.rgb * (1.0 - u_metallic);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= u_light_count) break;
    vec4 lp = u_lpos[i]; int type = int(lp.w + 0.5);
    vec3 L; float att = 1.0;
    if (type == 0) { L = -u_ldir[i].xyz; }
    else {
      vec3 rel = lp.xyz - v_world; float d = length(rel); L = rel / max(d, 0.0001);
      att = omni_attenuation(d, 1.0 / max(u_lparams[i].x, 0.0001), u_lparams[i].y);
      if (type == 2) {
        float cutoff = u_lparams[i].z;
        float scos = max(dot(-L, u_ldir[i].xyz), cutoff);
        float rim = max(0.0001, (1.0 - scos) / (1.0 - cutoff));
        att *= 1.0 - pow(rim, u_lparams[i].w);
      }
    }
    float NdL = max(dot(N, L), 0.0);
    if (NdL <= 0.0 || att <= 0.0) continue;
#ifdef SHADOWS
    if (u_ldir[i].w > 0.5) att *= shadow_factor();
#endif
    vec3 H = normalize(L + V); float NdH = max(dot(N, H), 0.0); float NdV = max(dot(N, V), 0.0001); float VdH = max(dot(V, H), 0.0);
    float dd = NdH * NdH * (a2 - 1.0) + 1.0; float D = a2 / (PI * dd * dd);
    float k = (rough + 1.0) * (rough + 1.0) / 8.0; float G = (NdV / (NdV * (1.0 - k) + k)) * (NdL / (NdL * (1.0 - k) + k));
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
    vec3 spec = D * G * F / (4.0 * NdV * NdL + 0.0001) * u_lcolor[i].w * 2.0;
    vec3 diff = (1.0 - F) * (1.0 - u_metallic) * albedo.rgb;
    col += (diff + spec * PI) * u_lcolor[i].rgb * NdL * att;
  }
#endif
  col += u_emission;
  frag = vec4(linear_to_srgb(max(col, vec3(0.0))), albedo.a);
}`;
const GLSL_DEPTH_VS = `
layout(location=0) in vec3 a_position;
layout(location=4) in mat4 a_model;
uniform mat4 u_view_proj;
void main() { gl_Position = u_view_proj * (a_model * vec4(a_position, 1.0)); }`;
const GLSL_DEPTH_FS = `
void main() {}`;
const GLSL_CANVAS_VS = `
layout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; layout(location=2) in vec4 a_col;
uniform vec2 u_screen; out vec2 v_uv; out vec4 v_col;
void main() { v_uv = a_uv; v_col = a_col; gl_Position = vec4(a_pos.x / u_screen.x * 2.0 - 1.0, 1.0 - a_pos.y / u_screen.y * 2.0, 0.0, 1.0); }`;
const GLSL_CANVAS_FS = `
in vec2 v_uv; in vec4 v_col; uniform sampler2D u_tex; out vec4 frag;
void main() { frag = texture(u_tex, v_uv) * v_col; }`;

// ── 3D + 2D renderer on WebGL2
const MAX_LIGHTS = 8;
class GLRenderer {
  constructor(backend) {
    this.backend = backend; this.gl = backend.gl; this._programs = new Map(); this._shader_errors = new Set();
    this._inst_data = new Float32Array(INSTANCE_FLOATS * 256);
    this._light_arrays = { pos: new Float32Array(MAX_LIGHTS * 4), dir: new Float32Array(MAX_LIGHTS * 4), color: new Float32Array(MAX_LIGHTS * 4), params: new Float32Array(MAX_LIGHTS * 4) };
    this._light_vp = new Float32Array(16); this._tmpm = new Float32Array(16);
    this._canvas_vb = new Float32Array(8 * 6 * 2048); this._canvas_count = 0; this._canvas_tex = null;
    this._init_gpu();
    backend.on_context_restored(() => this._init_gpu());
  }
  _init_gpu() {
    const b = this.backend, gl = this.gl;
    this._programs.clear();
    this._inst_buf = b.create_buffer(gl.ARRAY_BUFFER, this._inst_data.byteLength, gl.DYNAMIC_DRAW);
    this._shadow = null;
    this._white = b.create_texture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]), format: 'rgba8', filter: TextureFilter.NEAREST });
    this._canvas_buf = b.create_buffer(gl.ARRAY_BUFFER, this._canvas_vb.byteLength, gl.DYNAMIC_DRAW);
    this._canvas_vao = b.create_vao();
    gl.bindVertexArray(this._canvas_vao.h); gl.bindBuffer(gl.ARRAY_BUFFER, this._canvas_buf.h);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
    this._canvas_prog = b.create_program(GLSL_COMMON + GLSL_CANVAS_VS, GLSL_COMMON + GLSL_CANVAS_FS, 'canvas');
    this._depth_prog = b.create_program(GLSL_COMMON + GLSL_DEPTH_VS, GLSL_COMMON + GLSL_DEPTH_FS, 'depth');
  }
  _program(defines, material) {
    const key = defines.join(',') + (material instanceof ShaderMaterial ? '|sm' + material._id + ':' + material._version : '');
    let p = this._programs.get(key); if (p !== undefined) return p;
    const head = GLSL_COMMON + `#define MAX_LIGHTS ${MAX_LIGHTS}\n` + defines.map((d) => `#define ${d}\n`).join('');
    let fs = GLSL_LIGHT_FS;
    if (material instanceof ShaderMaterial) {
      fs = `in vec3 v_world; in vec3 v_normal; in vec2 v_uv; in vec4 v_color;\nout vec4 frag;\n${material.uniforms}\nvec3 linear_to_srgb(vec3 c) { return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }\nvoid main() {\n  vec4 COLOR = vec4(1.0);\n${material.code}\n  frag = vec4(linear_to_srgb(max(COLOR.rgb, vec3(0.0))), COLOR.a);\n}`;
    }
    try { p = this.backend.create_program(head + GLSL_MESH_VS, head + fs, material instanceof ShaderMaterial ? 'ShaderMaterial#' + material._id : 'StandardMaterial3D[' + defines.join(',') + ']'); }
    catch (e) {
      if (!this._shader_errors.has(key)) { this._shader_errors.add(key); Log.error(e.message); }
      p = null; // cached as failed; the surface is skipped
      if (material instanceof ShaderMaterial) material._last_error = e;
    }
    this._programs.set(key, p); return p;
  }
  // ── GPU upload of resources
  _mesh_entry(mesh) {
    let e = GPUCache.get(mesh, this.backend); if (e && e.version === mesh._version) return e;
    if (e) GPUCache.release(mesh, this.backend);
    const gl = this.gl, b = this.backend; const surfaces = [];
    for (const s of mesh._surfaces_ref()) {
      const a = s.arrays; const se = { vao: b.create_vao() };
      gl.bindVertexArray(se.vao.h);
      const attr = (name, loc, comps) => {
        if (!a[name]) { gl.disableVertexAttribArray(loc); return; }
        se[name] = b.create_buffer(gl.ARRAY_BUFFER, a[name], gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, comps, gl.FLOAT, false, 0, 0);
      };
      attr('vertex', ATTR.POSITION, 3); attr('normal', ATTR.NORMAL, 3); attr('tex_uv', ATTR.UV, 2); attr('color', ATTR.COLOR, 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._inst_buf.h);
      for (let i = 0; i < 4; i++) { gl.enableVertexAttribArray(ATTR.INST_MODEL + i); gl.vertexAttribPointer(ATTR.INST_MODEL + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16); gl.vertexAttribDivisor(ATTR.INST_MODEL + i, 1); }
      gl.enableVertexAttribArray(ATTR.INST_COLOR); gl.vertexAttribPointer(ATTR.INST_COLOR, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 64); gl.vertexAttribDivisor(ATTR.INST_COLOR, 1);
      if (a.index) { se.index = b.create_buffer(gl.ELEMENT_ARRAY_BUFFER, a.index, gl.STATIC_DRAW); se.index_type = a.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT; se.count = a.index.length; }
      else se.count = a.vertex.length / 3;
      se.mode = [gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP][s.primitive] ?? gl.TRIANGLES;
      gl.bindVertexArray(null);
      surfaces.push(se);
    }
    return GPUCache.set(mesh, b, { surfaces, version: mesh._version });
  }
  _texture_entry(tex, srgb) {
    let e = GPUCache.get(tex, this.backend);
    if (e && e.version !== tex._version) { GPUCache.release(tex, this.backend); e = null; }
    if (!e) e = GPUCache.set(tex, this.backend, { version: tex._version });
    const key = srgb ? 'srgb' : 'linear';
    if (!e[key]) {
      const img = tex.get_image(); if (!img) return this._white;
      e[key] = this.backend.create_texture({ width: img.width, height: img.height, data: img.data, format: srgb ? 'srgba8' : 'rgba8', filter: tex.filter, mipmaps: tex.filter >= 2, repeat: tex.repeat });
    }
    return e[key];
  }
  _ensure_shadow_map(size) {
    if (this._shadow && this._shadow.size === size && this._shadow.tex.gen === this.backend.gen && this._shadow.tex.alive) return this._shadow;
    if (this._shadow) { this.backend.delete_framebuffer(this._shadow.fb); this.backend.delete_texture(this._shadow.tex); }
    const tex = this.backend.create_texture({ width: size, height: size, format: 'depth24', compare: true });
    const fb = this.backend.create_framebuffer({ depth: tex });
    return (this._shadow = { tex, fb, size });
  }
  // ── frame
  render(vp, tree) {
    const b = this.backend, gl = this.gl; if (b.lost || gl.isContextLost()) return false;
    b.stats.reset_frame();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; vp._size.set(w, h);
    const rl = extract_render_list(vp, w / Math.max(1, h), b.stats);
    const clear = rl.clear;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
    gl.clearColor(clear.r, clear.g, clear.b, vp.transparent_bg ? 0 : clear.a);
    gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (rl.camera) this._render_3d(rl, w, h);
    this._render_canvas(vp, tree, w, h);
    b._check('frame');
    return true;
  }
  _gather_batches(items) {
    // Group by (surface entry, material): every group is drawn with one instanced call.
    const groups = new Map();
    for (const inst of items) {
      if (inst instanceof MultiMeshInstance3D) {
        const mm = inst.multimesh; const e = this._mesh_entry(mm.mesh);
        e.surfaces.forEach((se, i) => groups.set(Symbol('mm'), { se, mat: inst.material_override || mm.mesh.surface_get_material(i), list: null, mm, inst }));
        continue;
      }
      const e = this._mesh_entry(inst.mesh);
      for (let i = 0; i < e.surfaces.length; i++) {
        const mat = inst.get_active_material(i); const se = e.surfaces[i];
        let byMat = groups.get(se); if (!byMat) { byMat = new Map(); groups.set(se, byMat); }
        let g = byMat.get(mat); if (!g) { g = { se, mat, list: [] }; byMat.set(mat, g); }
        g.list.push(inst);
      }
    }
    const out = [];
    for (const v of groups.values()) { if (v instanceof Map) for (const g of v.values()) out.push(g); else out.push(v); }
    return out;
  }
  _fill_instances(g, cam_pos) {
    let n, data;
    if (g.mm) {
      const mm = g.mm; n = mm.visible_instance_count < 0 ? mm.instance_count : Math.min(mm.instance_count, mm.visible_instance_count);
      data = this._reserve(n); const parent = g.inst._global_ref(); const tmp = this._tmpm; const pm = Mat4.from_transform3d(parent, this._pm || (this._pm = new Float32Array(16)));
      for (let i = 0; i < n; i++) {
        Mat4.multiply(pm, mm._xf.subarray(i * 16, i * 16 + 16), tmp); data.set(tmp, i * INSTANCE_FLOATS);
        const o = i * INSTANCE_FLOATS + 16; if (mm.use_colors) { data[o] = mm._col[i * 4]; data[o + 1] = mm._col[i * 4 + 1]; data[o + 2] = mm._col[i * 4 + 2]; data[o + 3] = mm._col[i * 4 + 3]; } else { data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 1; }
      }
    } else {
      const list = g.list; n = list.length; data = this._reserve(n);
      const tmp = this._tmpm;
      for (let i = 0; i < n; i++) {
        Mat4.from_transform3d(list[i]._global_ref(), tmp); data.set(tmp, i * INSTANCE_FLOATS);
        const c = list[i].instance_color, o = i * INSTANCE_FLOATS + 16; data[o] = c.r; data[o + 1] = c.g; data[o + 2] = c.b; data[o + 3] = c.a;
      }
    }
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this._inst_buf.h);
    const bytes = n * INSTANCE_FLOATS * 4;
    if (bytes > this._inst_buf.bytes) this.backend.update_buffer(this._inst_buf, data.subarray(0, n * INSTANCE_FLOATS));
    else gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * INSTANCE_FLOATS);
    return n;
  }
  _reserve(n) { if (this._inst_data.length < n * INSTANCE_FLOATS) { let c = this._inst_data.length; while (c < n * INSTANCE_FLOATS) c *= 2; this._inst_data = new Float32Array(c); } return this._inst_data; }
  _draw_surface(se, count) {
    const gl = this.gl; gl.bindVertexArray(se.vao.h);
    if (se.index) gl.drawElementsInstanced(se.mode, se.count, se.index_type, 0, count); else gl.drawArraysInstanced(se.mode, 0, se.count, count);
    const st = this.backend.stats.frame; st.draw_calls++; st.primitives += (se.mode === gl.TRIANGLES ? se.count / 3 : se.count) * count;
  }
  _compute_light_vp(light, rl) {
    // Fit an orthographic light frustum around receivers+casters, limited to directional_shadow_max_distance from the camera.
    const dir = light._global_ref().basis.xform(Vector3.FORWARD).normalized();
    const up = Math.abs(dir.y) > 0.99 ? new Vector3(1, 0, 0) : Vector3.UP;
    const maxd = light.directional_shadow_max_distance; let acc = null;
    const add = (inst) => { const a = inst.get_world_aabb(); if (a.get_center().distance_to(rl.cam_pos) - a.size.length() / 2 > maxd) return; acc = acc ? acc.merge(a) : a.clone(); };
    for (const i of rl.items) add(i); for (const i of rl.casters) add(i);
    if (!acc) return false;
    const center = acc.get_center();
    const lt = new Transform3D(Basis.looking_at(dir, up), center); const inv = lt.affine_inverse();
    const mn = new Vector3(Infinity, Infinity, Infinity), mx = new Vector3(-Infinity, -Infinity, -Infinity); const p = acc.position, s = acc.size;
    for (let i = 0; i < 8; i++) { const c = inv.xform(new Vector3(p.x + (i & 1 ? s.x : 0), p.y + (i & 2 ? s.y : 0), p.z + (i & 4 ? s.z : 0))); mn.set(Math.min(mn.x, c.x), Math.min(mn.y, c.y), Math.min(mn.z, c.z)); mx.set(Math.max(mx.x, c.x), Math.max(mx.y, c.y), Math.max(mx.z, c.z)); }
    const pad = 0.01 * Math.max(mx.x - mn.x, mx.y - mn.y, 1);
    const proj = Mat4.orthographic(mn.x - pad, mx.x + pad, mn.y - pad, mx.y + pad, -mx.z - pad, -mn.z + pad, this._tmpm);
    Mat4.multiply(proj, Mat4.from_transform3d(inv), this._light_vp);
    this._shadow_world_per_texel = (mx.x - mn.x + 2 * pad) / RenderingServer.directional_shadow_size;
    this._shadow_depth_range = (mx.z - mn.z) + 2 * pad;
    return true;
  }
  _render_shadow(light, rl) {
    const gl = this.gl; const sm = this._ensure_shadow_map(RenderingServer.directional_shadow_size);
    if (!this._compute_light_vp(light, rl)) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fb.h); gl.viewport(0, 0, sm.size, sm.size);
    gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE); // both faces: avoids light leaking for thin/open meshes
    gl.useProgram(this._depth_prog.h); gl.uniformMatrix4fv(this._depth_prog.uniforms.get('u_view_proj'), false, this._light_vp);
    const before = this.backend.stats.frame.draw_calls;
    for (const g of this._gather_batches(rl.casters)) { const n = this._fill_instances(g); if (n) this._draw_surface(g.se, n); }
    this.backend.stats.frame.shadow_draw_calls = this.backend.stats.frame.draw_calls - before;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }
  _render_3d(rl, w, h) {
    const gl = this.gl;
    let shadowLight = null;
    for (const l of rl.lights) if (l instanceof DirectionalLight3D && l.shadow_enabled) { shadowLight = l; break; }
    const hasShadow = shadowLight ? this._render_shadow(shadowLight, rl) : false;
    gl.viewport(0, 0, w, h);
    // Light uniforms (linear color * energy)
    const L = this._light_arrays; let lc = 0;
    for (const l of rl.lights) {
      if (lc >= MAX_LIGHTS) { if (!this._warned_lights) { Log.warn(`More than ${MAX_LIGHTS} lights visible; extra lights ignored`); this._warned_lights = true; } break; }
      const g = l._global_ref(); const o = lc * 4; const lin = l.light_color.srgb_to_linear();
      const type = l instanceof DirectionalLight3D ? 0 : l instanceof SpotLight3D ? 2 : 1;
      const d = g.basis.xform(Vector3.FORWARD).normalized();
      L.pos[o] = g.origin.x; L.pos[o + 1] = g.origin.y; L.pos[o + 2] = g.origin.z; L.pos[o + 3] = type;
      L.dir[o] = d.x; L.dir[o + 1] = d.y; L.dir[o + 2] = d.z; L.dir[o + 3] = l === shadowLight && hasShadow ? 1 : 0;
      L.color[o] = lin.r * l.light_energy; L.color[o + 1] = lin.g * l.light_energy; L.color[o + 2] = lin.b * l.light_energy; L.color[o + 3] = l.light_specular;
      if (type === 1) { L.params[o] = l.omni_range; L.params[o + 1] = l.omni_attenuation; }
      if (type === 2) { L.params[o] = l.spot_range; L.params[o + 1] = l.spot_attenuation; L.params[o + 2] = Math.cos(MathUtil.deg_to_rad(l.spot_angle)); L.params[o + 3] = l.spot_angle_attenuation; }
      lc++;
    }
    const amb = rl.env ? rl.env.ambient_light_color.srgb_to_linear().mul(rl.env.ambient_light_energy) : new Color(0, 0, 0);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    const batches = this._gather_batches(rl.items);
    const isTransparent = (m) => !!m && m.transparency === Transparency.TRANSPARENCY_ALPHA;
    const opaque = batches.filter((g) => !isTransparent(g.mat)), trans = batches.filter((g) => isTransparent(g.mat));
    if (trans.length) { // back-to-front by first instance distance
      const dist = (g) => (g.list ? g.list[0] : g.inst).get_world_aabb().get_center().distance_squared_to(rl.cam_pos);
      trans.sort((a, b) => dist(b) - dist(a));
    }
    let lastProg = null;
    for (const pass of [opaque, trans]) {
      if (pass === trans) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      else { gl.disable(gl.BLEND); gl.depthMask(true); }
      for (const g of pass) {
        const mat = g.mat;
        const defines = [];
        const sm = mat instanceof StandardMaterial3D ? mat : null;
        if (sm && sm.shading_mode === ShadingMode.SHADING_MODE_UNSHADED) defines.push('UNSHADED');
        if (sm && sm.albedo_texture) defines.push('ALBEDO_TEX');
        if (hasShadow && !(sm && sm.shading_mode === 0) && !(mat instanceof ShaderMaterial)) defines.push('SHADOWS');
        const prog = this._program(defines, mat); if (!prog) continue;
        const U = prog.uniforms;
        if (prog !== lastProg) {
          gl.useProgram(prog.h); lastProg = prog;
          gl.uniformMatrix4fv(U.get('u_view_proj'), false, rl.view_proj);
          if (U.has('u_camera_pos')) gl.uniform3f(U.get('u_camera_pos'), rl.cam_pos.x, rl.cam_pos.y, rl.cam_pos.z);
          if (U.has('u_light_count')) {
            gl.uniform1i(U.get('u_light_count'), lc);
            gl.uniform4fv(U.get('u_lpos'), L.pos); gl.uniform4fv(U.get('u_ldir'), L.dir); gl.uniform4fv(U.get('u_lcolor'), L.color); gl.uniform4fv(U.get('u_lparams'), L.params);
            gl.uniform3f(U.get('u_ambient'), amb.r, amb.g, amb.b);
          }
          if (U.has('u_light_vp')) {
            gl.uniformMatrix4fv(U.get('u_light_vp'), false, this._light_vp);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._shadow.tex.h); gl.uniform1i(U.get('u_shadow_map'), 1);
            gl.uniform1f(U.get('u_shadow_texel'), 1 / this._shadow.size);
            // shadow_bias/normal_bias are expressed in shadow-map texels (approximating Godot's texel-scaled bias).
            gl.uniform1f(U.get('u_shadow_bias'), shadowLight.shadow_bias * this._shadow_world_per_texel / this._shadow_depth_range);
            gl.uniform1f(U.get('u_normal_bias'), shadowLight.shadow_normal_bias * this._shadow_world_per_texel * 0.5);
          }
        }
        // material uniforms
        if (sm || !mat) {
          const m = sm || _defaultMaterial; const c = m.albedo_color.srgb_to_linear();
          gl.uniform4f(U.get('u_albedo'), c.r, c.g, c.b, c.a);
          if (U.has('u_metallic')) { gl.uniform1f(U.get('u_metallic'), m.metallic); gl.uniform1f(U.get('u_roughness'), m.roughness); gl.uniform1f(U.get('u_specular'), m.metallic_specular); }
          const e = m.emission_enabled ? m.emission.srgb_to_linear().mul(m.emission_energy_multiplier) : null;
          if (U.has('u_emission')) gl.uniform3f(U.get('u_emission'), e ? e.r : 0, e ? e.g : 0, e ? e.b : 0);
          if (U.has('u_uv_scale')) gl.uniform2f(U.get('u_uv_scale'), m.uv1_scale.x, m.uv1_scale.y);
          if (m.albedo_texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._texture_entry(m.albedo_texture, true).h); gl.uniform1i(U.get('u_albedo_tex'), 0); }
        } else if (mat instanceof ShaderMaterial) {
          if (U.has('u_uv_scale')) gl.uniform2f(U.get('u_uv_scale'), 1, 1);
          for (const [k, v] of mat._params) {
            const loc = U.get(k); if (!loc) continue;
            if (typeof v === 'number') gl.uniform1f(loc, v); else if (v instanceof Vector2) gl.uniform2f(loc, v.x, v.y);
            else if (v instanceof Vector3) gl.uniform3f(loc, v.x, v.y, v.z); else if (v instanceof Color) { const c = v.srgb_to_linear(); gl.uniform4f(loc, c.r, c.g, c.b, c.a); }
            else if (v instanceof Vector4) gl.uniform4f(loc, v.x, v.y, v.z, v.w);
          }
        }
        const cull = mat ? mat.cull_mode : CullMode.CULL_BACK;
        if (cull === CullMode.CULL_DISABLED) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(cull === CullMode.CULL_FRONT ? gl.FRONT : gl.BACK); }
        const n = this._fill_instances(g); if (n) this._draw_surface(g.se, n);
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.bindVertexArray(null);
  }
  // ── 2D batching: one draw call per run of items sharing a texture.
  _render_canvas(vp, tree, w, h) {
    const items = extract_canvas_items(tree); if (!items.length) return;
    const gl = this.gl; const st = this.backend.stats.frame;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this._canvas_prog.h); gl.uniform2f(this._canvas_prog.uniforms.get('u_screen'), w, h); gl.uniform1i(this._canvas_prog.uniforms.get('u_tex'), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(this._canvas_vao.h);
    const cam = vp._camera_2d && vp._camera_2d._tree && vp._camera_2d.enabled ? vp._camera_2d : null;
    const canvasT = cam ? cam.get_canvas_transform(vp._size) : vp.canvas_transform;
    const xf = this._cxf || (this._cxf = new Transform2D());
    this._canvas_count = 0; this._canvas_tex = null;
    for (const it of items) {
      Transform2D.mul_into(canvasT, it.get_global_transform(), xf);
      const mod = this._modulate(it);
      st.items_2d++;
      if (it instanceof Sprite2D && it.texture) {
        const r = it.get_rect(); const uv = it._source_uv();
        this._quad(xf, r.position.x, r.position.y, r.size.x, r.size.y, uv[0], uv[1], uv[2], uv[3], mod, this._texture_entry(it.texture, false));
      }
      if (it._draw_ui) it._draw_ui(this, xf, mod);
      const cmds = it._collect_draw();
      if (cmds) for (const c of cmds) this._cmd(xf, c, mod);
    }
    this._flush_canvas();
    gl.disable(gl.BLEND); gl.bindVertexArray(null);
  }
  _modulate(it) {
    let r = it.self_modulate.r, g = it.self_modulate.g, b = it.self_modulate.b, a = it.self_modulate.a;
    let n = it; while (n) { if (n instanceof CanvasItem) { r *= n.modulate.r; g *= n.modulate.g; b *= n.modulate.b; a *= n.modulate.a; } n = n._parent; }
    const m = this._modc || (this._modc = new Color()); return m.set(r, g, b, a);
  }
  _set_tex(t) { if (this._canvas_tex !== t) { if (this._canvas_count) this._flush_canvas(); this._canvas_tex = t; } }
  _vert(x, y, u, v, c) {
    if (this._canvas_count * 8 >= this._canvas_vb.length) this._flush_canvas();
    const o = this._canvas_count * 8, b = this._canvas_vb; b[o] = x; b[o + 1] = y; b[o + 2] = u; b[o + 3] = v; b[o + 4] = c.r; b[o + 5] = c.g; b[o + 6] = c.b; b[o + 7] = c.a; this._canvas_count++;
  }
  _tri(xf, ax, ay, bx, by, cx, cy, col, au = 0, av = 0, bu = 0, bv = 0, cu = 0, cv = 0) {
    if ((this._canvas_count + 3) * 8 > this._canvas_vb.length) this._flush_canvas();
    const X = (x, y) => xf.x.x * x + xf.y.x * y + xf.origin.x, Y = (x, y) => xf.x.y * x + xf.y.y * y + xf.origin.y;
    this._vert(X(ax, ay), Y(ax, ay), au, av, col); this._vert(X(bx, by), Y(bx, by), bu, bv, col); this._vert(X(cx, cy), Y(cx, cy), cu, cv, col);
  }
  _quad(xf, x, y, w, h, u0, v0, u1, v1, col, tex) {
    this._set_tex(tex || this._white);
    if ((this._canvas_count + 6) * 8 > this._canvas_vb.length) this._flush_canvas();
    this._tri(xf, x, y, x + w, y, x + w, y + h, col, u0, v0, u1, v0, u1, v1);
    this._tri(xf, x, y, x + w, y + h, x, y + h, col, u0, v0, u1, v1, u0, v1);
  }
  _cmd(xf, c, mod) {
    const col = c.color.mul(mod);
    switch (c.k) {
      case 'rect': this._quad(xf, c.x, c.y, c.w, c.h, 0, 0, 1, 1, col, c.tex ? this._texture_entry(c.tex, false) : null); break;
      case 'circle': { this._set_tex(this._white); const n = c.seg; for (let i = 0; i < n; i++) { const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2; this._tri(xf, c.x, c.y, c.x + Math.cos(a0) * c.r, c.y + Math.sin(a0) * c.r, c.x + Math.cos(a1) * c.r, c.y + Math.sin(a1) * c.r, col); } break; }
      case 'line': { this._set_tex(this._white); const dx = c.bx - c.ax, dy = c.by - c.ay, l = Math.hypot(dx, dy) || 1, nx = -dy / l * c.w / 2, ny = dx / l * c.w / 2;
        this._tri(xf, c.ax + nx, c.ay + ny, c.bx + nx, c.by + ny, c.bx - nx, c.by - ny, col); this._tri(xf, c.ax + nx, c.ay + ny, c.bx - nx, c.by - ny, c.ax - nx, c.ay - ny, col); break; }
      case 'poly': { this._set_tex(this._white); for (const [a, b, d] of triangulate_polygon(c.pts)) this._tri(xf, c.pts[a][0], c.pts[a][1], c.pts[b][0], c.pts[b][1], c.pts[d][0], c.pts[d][1], col); break; }
      case 'text': if (c.tex) this._quad(xf, c.x, c.y, c.w, c.h, 0, 0, 1, 1, col, this._texture_entry(c.tex, false)); break;
    }
  }
  _flush_canvas() {
    if (!this._canvas_count) return;
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, (this._canvas_tex || this._white).h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._canvas_buf.h); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._canvas_vb, 0, this._canvas_count * 8);
    gl.drawArrays(gl.TRIANGLES, 0, this._canvas_count);
    const st = this.backend.stats.frame; st.draw_calls++; st.batches_2d++; st.primitives += this._canvas_count / 3;
    this._canvas_count = 0;
  }
  dispose() {
    const b = this.backend; for (const p of this._programs.values()) if (p) b.delete_program(p); this._programs.clear();
    if (this._shadow) { b.delete_framebuffer(this._shadow.fb); b.delete_texture(this._shadow.tex); this._shadow = null; }
    b.delete_buffer(this._inst_buf); b.delete_buffer(this._canvas_buf); b.delete_vao(this._canvas_vao); b.delete_texture(this._white);
    b.delete_program(this._canvas_prog); b.delete_program(this._depth_prog);
  }
}
const _defaultMaterial = new StandardMaterial3D();

// Ear clipping for simple polygons (any winding). Returns index triples.
function triangulate_polygon(pts) {
  const n = pts.length; if (n < 3) return [];
  let area = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const idx = []; for (let i = 0; i < n; i++) idx.push(i); if (area < 0) idx.reverse();
  const out = []; let guard = 0;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(a, b, c) <= 0) continue;
      let ok = true; for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; if (inside(pts[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      out.push([i0, i1, i2]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) { Log.error('triangulate_polygon: polygon is not simple'); return out; }
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// ── Display: binds a canvas + backend + renderer to a Viewport (root Window) and draws each frame.
class Display {
  constructor(tree, canvas, opts = {}) {
    this.tree = tree; this.canvas = canvas; this.opts = opts; this.backend = null; this.renderer = null; this.backend_name = null;
    this.auto_resize = opts.auto_resize !== false;
  }
  static async create(tree, canvas, opts = {}) {
    const d = new Display(tree, canvas, opts); const want = opts.backend || 'webgl2';
    if (want === 'webgpu' || want === 'auto') {
      try { await d._init_webgpu(); }
      catch (e) {
        if (want === 'webgpu' && !opts.fallback) throw e;
        Log.warn('WebGPU unavailable, falling back to WebGL2:', e.message);
        d.fallback_reason = e.message;
        // A canvas that had a webgpu context cannot switch to webgl2; callers get a fresh canvas.
        if (d._canvas_tainted) { const c2 = document.createElement('canvas'); c2.width = canvas.width; c2.height = canvas.height; if (canvas.parentNode) canvas.parentNode.replaceChild(c2, canvas); d.canvas = c2; }
      }
    }
    if (!d.renderer) d._init_webgl2();
    d._attach();
    return d;
  }
  static create_sync(tree, canvas, opts = {}) { const d = new Display(tree, canvas, opts); d._init_webgl2(); d._attach(); return d; }
  _init_webgl2() { this.backend = new WebGL2Backend(this.canvas, this.opts); this.renderer = new GLRenderer(this.backend); this.backend_name = 'webgl2'; }
  async _init_webgpu() {
    if (typeof WebGPURenderer === 'undefined') throw new Error('WebGPU renderer not built');
    const r = await WebGPURenderer.create(this.canvas, this.opts, this);
    this.renderer = r; this.backend = r.backend; this.backend_name = 'webgpu';
  }
  _attach() {
    this._hook = (tree) => (tree === this.tree ? this.draw() : false);
    SceneTreeHooks.draw.push(this._hook);
    this.tree.root._display = this;
    this.tree.root._on_tree_free = () => this.dispose();
  }
  draw() {
    if (this.auto_resize && this.canvas.clientWidth && typeof devicePixelRatio !== 'undefined') {
      const w = Math.round(this.canvas.clientWidth * devicePixelRatio), h = Math.round(this.canvas.clientHeight * devicePixelRatio);
      if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) { this.canvas.width = w; this.canvas.height = h; this.tree.root.emit_signal('size_changed'); }
    }
    return this.renderer.render(this.tree.root, this.tree);
  }
  get stats() { return this.backend.stats; }
  // Pixel readback with a top-left origin (y down), for tests and screenshots.
  read_pixels(x = 0, y = 0, w = this.canvas.width, h = this.canvas.height) {
    if (this.renderer.read_pixels_top_left) return this.renderer.read_pixels_top_left(x, y, w, h);
    const raw = this.backend.read_pixels(x, this.canvas.height - y - h, w, h); const out = new Uint8Array(raw.length); const row = w * 4;
    for (let j = 0; j < h; j++) out.set(raw.subarray((h - 1 - j) * row, (h - j) * row), j * row);
    return out;
  }
  dispose() {
    if (this._disposed) return; this._disposed = true;
    const i = SceneTreeHooks.draw.indexOf(this._hook); if (i >= 0) SceneTreeHooks.draw.splice(i, 1);
    if (this.renderer) this.renderer.dispose(); if (this.backend) this.backend.dispose();
  }
}
Viewport.prototype.attach_canvas = function (canvas, opts) { if (!this._tree) throw new Error('attach_canvas: viewport is not in a tree'); return Display.create_sync(this._tree, canvas, opts); };

Object.assign(_ext, {
  GPUStats, ShaderCompileError, Image, Texture2D, ImageTexture, TextureFilter, Mesh, ArrayMesh, PrimitiveMesh, BoxMesh, PlaneMesh, QuadMesh,
  SphereMesh, CylinderMesh, CapsuleMesh, PrimitiveType, Material, StandardMaterial3D, ShaderMaterial, ShadingMode, Transparency, CullMode,
  Environment, WorldEnvironment, RenderingServer, VisualInstance3D, GeometryInstance3D, MeshInstance3D, MultiMesh, MultiMeshInstance3D, ShadowCasting,
  Light3D, DirectionalLight3D, OmniLight3D, SpotLight3D, Camera3D, Sprite2D, Camera2D, WebGL2Backend, GLRenderer, Display,
  triangulate_polygon, aabb_in_frustum,
});

// §7 ─────────────────────────────────────────────────────────────────────────
// Own 3D physics: SAP broad-phase, analytic/SAT narrow-phase, sequential-impulse solver with warm starting.
const PhysicsSettings = {
  default_gravity: 9.8, default_gravity_vector: new Vector3(0, -1, 0),
  default_linear_damp: 0.1, default_angular_damp: 0.1,           // ProjectSettings physics/3d defaults
  sleep_threshold_linear: 0.1, sleep_threshold_angular: MathUtil.deg_to_rad(8), time_before_sleep: 0.5,
  solver_iterations: 16, contact_slop: 0.005, baumgarte: 0.2, bounce_threshold: 1.0, max_contacts_per_pair: 4,
};

class Shape3D extends Resource { constructor() { super(); this.margin = 0.04; this._version = 0; } _bump() { this._version++; this.emit_changed(); } }
ClassDB.register(Shape3D, 'Shape3D', [{ name: 'margin', type: 'float' }], { abstract: true });
class BoxShape3D extends Shape3D {
  constructor() { super(); this._size = new Vector3(1, 1, 1); }
  get size() { return this._size.clone(); } set size(v) { this._size.copy(v); this._bump(); }
  _local_aabb() { return new AABB(this._size.mul(-0.5), this._size); }
}
ClassDB.register(BoxShape3D, 'BoxShape3D', [{ name: 'size', type: 'Vector3' }]);
class SphereShape3D extends Shape3D {
  constructor() { super(); this._radius = 0.5; }
  get radius() { return this._radius; } set radius(v) { this._radius = v; this._bump(); }
  _local_aabb() { const r = this._radius; return new AABB(new Vector3(-r, -r, -r), new Vector3(2 * r, 2 * r, 2 * r)); }
}
ClassDB.register(SphereShape3D, 'SphereShape3D', [{ name: 'radius', type: 'float' }]);
class CapsuleShape3D extends Shape3D { // Y-aligned; height includes the hemispherical caps (Godot 4)
  constructor() { super(); this._radius = 0.5; this._height = 2; }
  get radius() { return this._radius; } set radius(v) { this._radius = v; this._bump(); }
  get height() { return this._height; } set height(v) { this._height = v; this._bump(); }
  get mid_height() { return Math.max(0, this._height - 2 * this._radius); }
  _local_aabb() { const r = this._radius, h = Math.max(this._height, 2 * r) / 2; return new AABB(new Vector3(-r, -h, -r), new Vector3(2 * r, 2 * h, 2 * r)); }
}
ClassDB.register(CapsuleShape3D, 'CapsuleShape3D', [{ name: 'radius', type: 'float' }, { name: 'height', type: 'float' }]);
class WorldBoundaryShape3D extends Shape3D {
  constructor() { super(); this._plane = new Plane(new Vector3(0, 1, 0), 0); }
  get plane() { return this._plane.clone(); } set plane(p) { this._plane = p.clone(); this._bump(); }
  _local_aabb() { const B = 1e6; return new AABB(new Vector3(-B, -B, -B), new Vector3(2 * B, 2 * B, 2 * B)); }
}
ClassDB.register(WorldBoundaryShape3D, 'WorldBoundaryShape3D', [{ name: 'plane', type: 'Plane' }]);

class PhysicsMaterial extends Resource { constructor() { super(); this.friction = 1; this.rough = false; this.bounce = 0; this.absorbent = false; } }
ClassDB.register(PhysicsMaterial, 'PhysicsMaterial', [{ name: 'friction', type: 'float' }, { name: 'rough', type: 'bool' }, { name: 'bounce', type: 'float' }, { name: 'absorbent', type: 'bool' }]);

const SHAPE_SPHERE = 0, SHAPE_BOX = 1, SHAPE_CAPSULE = 2, SHAPE_PLANE = 3;
const _shape_type = (s) => (s instanceof SphereShape3D ? SHAPE_SPHERE : s instanceof BoxShape3D ? SHAPE_BOX : s instanceof CapsuleShape3D ? SHAPE_CAPSULE : s instanceof WorldBoundaryShape3D ? SHAPE_PLANE : -1);

// ── Narrow phase. All functions push {n (A->B), p (world), depth} into out.
const _v = () => new Vector3();
const _t1 = _v(), _t2 = _v(), _t3 = _v(), _t4 = _v();
function _closest_on_segment(a, b, p, out) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z; const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}
function _closest_segments(p1, q1, p2, q2, c1, c2) { // Ericson, Real-Time Collision Detection 5.1.9
  const d1 = q1.sub(p1), d2 = q2.sub(p2), r = p1.sub(p2); const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
  else if (a <= 1e-12) { s = 0; t = MathUtil.clamp(f / e, 0, 1); }
  else { const c = d1.dot(r); if (e <= 1e-12) { t = 0; s = MathUtil.clamp(-c / a, 0, 1); }
    else { const b = d1.dot(d2), den = a * e - b * b; s = den !== 0 ? MathUtil.clamp((b * f - c * e) / den, 0, 1) : 0; t = (b * s + f) / e;
      if (t < 0) { t = 0; s = MathUtil.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = MathUtil.clamp((b - c) / a, 0, 1); } } }
  c1.copy(p1).iadd_scaled(d1, s); c2.copy(p2).iadd_scaled(d2, t); return c1.distance_to(c2);
}
function _capsule_segment(shape, T, a, b) {
  const h = shape.mid_height / 2; const up = T.basis.y.normalized();
  a.copy(T.origin).iadd_scaled(up, h); b.copy(T.origin).iadd_scaled(up, -h);
}
function _sphere_sphere(ca, ra, cb, rb, out) {
  const d = cb.sub(ca); const dist = d.length(); const depth = ra + rb - dist; if (depth <= 0) return 0;
  const n = dist > 1e-9 ? d.div(dist) : new Vector3(0, 1, 0);
  out.push({ n, p: ca.add(n.mul(ra - depth * 0.5)), depth }); return 1;
}
function _world_plane(shape, T) { const n = T.basis.xform(shape._plane.normal).normalized(); const p0 = T.xform(shape._plane.normal.mul(shape._plane.d)); return { n, d: n.dot(p0) }; }
function _sphere_plane(c, r, pl, out) { // A = sphere, B = plane
  const dist = pl.n.dot(c) - pl.d; const depth = r - dist; if (depth <= 0) return 0;
  out.push({ n: pl.n.neg(), p: c.sub(pl.n.mul(dist)), depth }); return 1;
}
function _sphere_box(c, r, T, half, out) { // A = sphere, B = box (T orthonormal)
  const l = T.xform_inv(c); const q = new Vector3(MathUtil.clamp(l.x, -half.x, half.x), MathUtil.clamp(l.y, -half.y, half.y), MathUtil.clamp(l.z, -half.z, half.z));
  if (q.x === l.x && q.y === l.y && q.z === l.z) { // center inside: push out through nearest face
    const dx = half.x - Math.abs(l.x), dy = half.y - Math.abs(l.y), dz = half.z - Math.abs(l.z);
    let nl; let pen;
    if (dx <= dy && dx <= dz) { nl = new Vector3(Math.sign(l.x) || 1, 0, 0); pen = dx; } else if (dy <= dz) { nl = new Vector3(0, Math.sign(l.y) || 1, 0); pen = dy; } else { nl = new Vector3(0, 0, Math.sign(l.z) || 1); pen = dz; }
    const nw = T.basis.xform(nl); out.push({ n: nw.neg(), p: c.clone(), depth: pen + r }); return 1;
  }
  const qw = T.xform(q); const d = c.sub(qw); const dist = d.length(); if (dist >= r) return 0;
  const nbs = d.div(dist); out.push({ n: nbs.neg(), p: qw, depth: r - dist }); return 1;
}
function _box_plane(T, half, pl, out) { // A = box, B = plane
  const pts = []; for (let i = 0; i < 8; i++) {
    const p = T.xform(new Vector3(i & 1 ? half.x : -half.x, i & 2 ? half.y : -half.y, i & 4 ? half.z : -half.z));
    const dist = pl.n.dot(p) - pl.d; if (dist < 0) pts.push({ n: pl.n.neg(), p: p.sub(pl.n.mul(dist * 0.5)), depth: -dist });
  }
  pts.sort((a, b) => b.depth - a.depth); for (let i = 0; i < Math.min(4, pts.length); i++) out.push(pts[i]); return Math.min(4, pts.length);
}
function _dedupe_push(cands, out, maxn) {
  cands.sort((a, b) => b.depth - a.depth); let n = 0; const kept = [];
  for (const c of cands) { if (kept.some((k) => k.p.distance_squared_to(c.p) < 1e-4)) continue; kept.push(c); out.push(c); if (++n >= maxn) break; }
  return n;
}
function _capsule_plane(shape, T, pl, out) {
  const a = _v(), b = _v(); _capsule_segment(shape, T, a, b); const c = []; _sphere_plane(a, shape._radius, pl, c); _sphere_plane(b, shape._radius, pl, c); return _dedupe_push(c, out, 2);
}
function _capsule_sphere(shape, T, cb, rb, out) { const a = _v(), b = _v(), q = _v(); _capsule_segment(shape, T, a, b); _closest_on_segment(a, b, cb, q); return _sphere_sphere(q, shape._radius, cb, rb, out); }
function _capsule_capsule(sa, Ta, sb, Tb, out) {
  const a0 = _v(), a1 = _v(), b0 = _v(), b1 = _v(); _capsule_segment(sa, Ta, a0, a1); _capsule_segment(sb, Tb, b0, b1);
  const c1 = _v(), c2 = _v(); _closest_segments(a0, a1, b0, b1, c1, c2);
  const cands = []; _sphere_sphere(c1, sa._radius, c2, sb._radius, cands);
  for (const p of [a0, a1]) { const q = _v(); _closest_on_segment(b0, b1, p, q); _sphere_sphere(p, sa._radius, q, sb._radius, cands); }
  for (const p of [b0, b1]) { const q = _v(); _closest_on_segment(a0, a1, p, q); _sphere_sphere(q, sa._radius, p, sb._radius, cands); }
  return _dedupe_push(cands, out, 2);
}
function _point_box_dist(p, T, half) { const l = T.xform_inv(p); const dx = Math.max(Math.abs(l.x) - half.x, 0), dy = Math.max(Math.abs(l.y) - half.y, 0), dz = Math.max(Math.abs(l.z) - half.z, 0); return Math.sqrt(dx * dx + dy * dy + dz * dz); }
function _capsule_box(shape, T, Tb, half, out) { // A = capsule, B = box
  const a = _v(), b = _v(); _capsule_segment(shape, T, a, b);
  let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (_point_box_dist(a.lerp(b, m1), Tb, half) < _point_box_dist(a.lerp(b, m2), Tb, half)) hi = m2; else lo = m1; }
  const cands = []; for (const p of [a, b, a.lerp(b, (lo + hi) / 2)]) _sphere_box(p, shape._radius, Tb, half, cands);
  return _dedupe_push(cands, out, 2);
}
// Box-box: SAT over 15 axes; face contacts by clipping the incident face against the reference face.
function _box_box(Ta, ha, Tb, hb, out) {
  const A = [Ta.basis.x.normalized(), Ta.basis.y.normalized(), Ta.basis.z.normalized()], B = [Tb.basis.x.normalized(), Tb.basis.y.normalized(), Tb.basis.z.normalized()];
  const HA = [ha.x, ha.y, ha.z], HB = [hb.x, hb.y, hb.z]; const D = Tb.origin.sub(Ta.origin);
  let best = Infinity, bestAxis = null, bestType = -1, bestI = 0, bestJ = 0;
  const test = (L, type, i, j) => {
    const len = L.length(); if (len < 1e-6) return true; L = L.div(len);
    let ra = 0, rb = 0; for (let k = 0; k < 3; k++) { ra += HA[k] * Math.abs(A[k].dot(L)); rb += HB[k] * Math.abs(B[k].dot(L)); }
    const ov = ra + rb - Math.abs(D.dot(L)); if (ov < 0) return false;
    const biased = type === 2 ? ov * 1.05 + 0.001 : ov; // prefer face contacts for stability
    if (biased < best) { best = biased; bestAxis = D.dot(L) < 0 ? L.neg() : L; bestType = type; bestI = i; bestJ = j; bestAxis._ov = ov; }
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(A[i], 0, i, 0)) return 0;
  for (let i = 0; i < 3; i++) if (!test(B[i], 1, i, 0)) return 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(A[i].cross(B[j]), 2, i, j)) return 0;
  const n = bestAxis, depth = bestAxis._ov;
  if (bestType === 2) {
    const pa = Ta.origin.clone(), pb = Tb.origin.clone();
    for (let k = 0; k < 3; k++) { if (k !== bestI) pa.iadd_scaled(A[k], HA[k] * Math.sign(A[k].dot(n)) || HA[k]); if (k !== bestJ) pb.iadd_scaled(B[k], -HB[k] * Math.sign(B[k].dot(n)) || HB[k]); }
    const a0 = pa.sub(A[bestI].mul(HA[bestI])), a1 = pa.add(A[bestI].mul(HA[bestI])), b0 = pb.sub(B[bestJ].mul(HB[bestJ])), b1 = pb.add(B[bestJ].mul(HB[bestJ]));
    const c1 = _v(), c2 = _v(); _closest_segments(a0, a1, b0, b1, c1, c2);
    out.push({ n: n.clone(), p: c1.add(c2).mul(0.5), depth }); return 1;
  }
  // reference face
  const refIsA = bestType === 0; const R = refIsA ? A : B, HR = refIsA ? HA : HB, I = refIsA ? B : A, HI = refIsA ? HB : HA;
  const cr = refIsA ? Ta.origin : Tb.origin, ci = refIsA ? Tb.origin : Ta.origin;
  const nr = refIsA ? n : n.neg(); const ri = bestI;
  // incident face: most anti-parallel to nr
  let ik = 0, md = -1; for (let k = 0; k < 3; k++) { const d = Math.abs(I[k].dot(nr)); if (d > md) { md = d; ik = k; } }
  const s = I[ik].dot(nr) > 0 ? -1 : 1; const fc = ci.add(I[ik].mul(s * HI[ik]));
  const u = I[(ik + 1) % 3], v = I[(ik + 2) % 3], hu = HI[(ik + 1) % 3], hv = HI[(ik + 2) % 3];
  let poly = [fc.add(u.mul(hu)).add(v.mul(hv)), fc.sub(u.mul(hu)).add(v.mul(hv)), fc.sub(u.mul(hu)).sub(v.mul(hv)), fc.add(u.mul(hu)).sub(v.mul(hv))];
  const rfc = cr.add(R[ri].mul(HR[ri] * Math.sign(R[ri].dot(nr)))); // reference face center
  const ru = R[(ri + 1) % 3], rv = R[(ri + 2) % 3], hru = HR[(ri + 1) % 3], hrv = HR[(ri + 2) % 3];
  const clip = (pts, axis, off) => { // keep axis·(p - rfc) <= off
    const res = []; for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length]; const dp = axis.dot(p.sub(rfc)) - off, dq = axis.dot(q.sub(rfc)) - off;
      if (dp <= 0) res.push(p); if ((dp < 0) !== (dq < 0) && dp !== dq) res.push(p.lerp(q, dp / (dp - dq)));
    }
    return res;
  };
  poly = clip(poly, ru, hru); poly = clip(poly, ru.neg(), hru); poly = clip(poly, rv, hrv); poly = clip(poly, rv.neg(), hrv);
  const cands = [];
  for (const p of poly) { const sep = nr.dot(p.sub(rfc)); if (sep < 0) cands.push({ n: n.clone(), p: p.sub(nr.mul(sep * 0.5)), depth: -sep }); }
  if (!cands.length) { out.push({ n: n.clone(), p: Ta.origin.add(D.mul(0.5)), depth }); return 1; }
  return _dedupe_push(cands, out, PhysicsSettings.max_contacts_per_pair);
}
// Dispatcher; returns number of contacts appended (normal from A to B).
function collide_shapes(sa, Ta, sb, Tb, out) {
  const ta = _shape_type(sa), tb = _shape_type(sb);
  if (ta > tb) { const tmp = []; const n = collide_shapes(sb, Tb, sa, Ta, tmp); for (const c of tmp) { c.n = c.n.neg(); out.push(c); } return n; }
  if (ta === SHAPE_SPHERE) {
    if (tb === SHAPE_SPHERE) return _sphere_sphere(Ta.origin, sa._radius, Tb.origin, sb._radius, out);
    if (tb === SHAPE_BOX) return _sphere_box(Ta.origin, sa._radius, Tb, sb._size.mul(0.5), out);
    if (tb === SHAPE_CAPSULE) { const tmp = []; _capsule_sphere(sb, Tb, Ta.origin, sa._radius, tmp); for (const c of tmp) { c.n = c.n.neg(); out.push(c); } return tmp.length; }
    if (tb === SHAPE_PLANE) return _sphere_plane(Ta.origin, sa._radius, _world_plane(sb, Tb), out);
  }
  if (ta === SHAPE_BOX) {
    if (tb === SHAPE_BOX) return _box_box(Ta, sa._size.mul(0.5), Tb, sb._size.mul(0.5), out);
    if (tb === SHAPE_CAPSULE) { const tmp = []; _capsule_box(sb, Tb, Ta, sa._size.mul(0.5), tmp); for (const c of tmp) { c.n = c.n.neg(); out.push(c); } return tmp.length; }
    if (tb === SHAPE_PLANE) return _box_plane(Ta, sa._size.mul(0.5), _world_plane(sb, Tb), out);
  }
  if (ta === SHAPE_CAPSULE) {
    if (tb === SHAPE_CAPSULE) return _capsule_capsule(sa, Ta, sb, Tb, out);
    if (tb === SHAPE_PLANE) return _capsule_plane(sa, Ta, _world_plane(sb, Tb), out);
  }
  return 0; // plane-plane: both static, never collide
}

// ── Ray casts against shapes (world-space). Returns {t, n} or null.
function _ray_sphere(o, d, c, r, maxT) {
  const m = o.sub(c); const b = m.dot(d), cc = m.dot(m) - r * r; if (cc > 0 && b > 0) return null;
  const disc = b * b - cc; if (disc < 0) return null; let t = -b - Math.sqrt(disc); if (t < 0) return null; // inside: no hit (hit_from_inside=false)
  if (t > maxT) return null; const p = o.add(d.mul(t)); return { t, n: p.sub(c).normalized() };
}
function _ray_box(o, d, T, half, maxT) {
  const lo = T.xform_inv(o), ld = T.basis.xform_inv(d); let tmin = 0, tmax = maxT, axis = -1, sign = 0;
  const L = [lo.x, lo.y, lo.z], LD = [ld.x, ld.y, ld.z], H = [half.x, half.y, half.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(LD[i]) < 1e-12) { if (L[i] < -H[i] || L[i] > H[i]) return null; continue; }
    let t1 = (-H[i] - L[i]) / LD[i], t2 = (H[i] - L[i]) / LD[i], s = -1; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; } if (t2 < tmax) tmax = t2; if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // origin inside box
  const nl = new Vector3(); nl[['x', 'y', 'z'][axis]] = sign; return { t: tmin, n: T.basis.xform(nl).normalized() };
}
function _ray_plane(o, d, pl, maxT) { const den = pl.n.dot(d); if (den >= 0) return null; const t = (pl.d - pl.n.dot(o)) / den; if (t < 0 || t > maxT) return null; return { t, n: pl.n.clone() }; }
function _ray_capsule(o, d, shape, T, maxT) {
  const a = _v(), b = _v(); _capsule_segment(shape, T, a, b); const r = shape._radius;
  let best = null; const consider = (h) => { if (h && (!best || h.t < best.t)) best = h; };
  consider(_ray_sphere(o, d, a, r, maxT)); consider(_ray_sphere(o, d, b, r, maxT));
  const ax = b.sub(a); const H = ax.length(); if (H > 1e-9) { // finite cylinder
    const u = ax.div(H); const m = o.sub(a); const md = m.dot(u), dd = d.dot(u);
    const mp = m.sub(u.mul(md)), dp = d.sub(u.mul(dd)); const A2 = dp.dot(dp), B2 = 2 * mp.dot(dp), C2 = mp.dot(mp) - r * r;
    if (A2 > 1e-12) { const disc = B2 * B2 - 4 * A2 * C2; if (disc >= 0 && C2 > 0) { const t = (-B2 - Math.sqrt(disc)) / (2 * A2); const s = md + t * dd;
      if (t >= 0 && t <= maxT && s >= 0 && s <= H) { const p = o.add(d.mul(t)); const q = a.add(u.mul(s)); consider({ t, n: p.sub(q).normalized() }); } } }
  }
  return best;
}

// ── Body state in the physics space
const BODY_STATIC = 0, BODY_KINEMATIC = 1, BODY_RIGID = 2, BODY_AREA = 3;
class PhysicsSpace3D {
  constructor() {
    this.bodies = []; this._pairs = new Map(); this._sap = []; this.gravity = PhysicsSettings.default_gravity; this.gravity_vector = PhysicsSettings.default_gravity_vector.clone();
    this.stats = { pairs_tested: 0, contacts: 0, active: 0, islands: 0 }; this._contacts = [];
  }
  add(b) { if (b._space) return; b._space = this; this.bodies.push(b); this._sap.push(b); b._sync_from_node(true); }
  remove(b) {
    if (b._space !== this) return; b._space = null;
    let i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1); i = this._sap.indexOf(b); if (i >= 0) this._sap.splice(i, 1);
    for (const [k, m] of this._pairs) if (m.a === b || m.b === b) this._pairs.delete(k);
    for (const o of this.bodies) { if (o._overlaps) o._overlaps.delete(b); if (o._contact_set) o._contact_set.delete(b); }
  }
  static can_collide(a, b) { return (a.collision_layer & b.collision_mask) !== 0 || (b.collision_layer & a.collision_mask) !== 0; }
  // Sweep-and-prune on X with insertion sort (cheap when order is temporally coherent).
  _broadphase(cb) {
    const s = this._sap;
    for (let i = 1; i < s.length; i++) { const b = s[i]; let j = i - 1; while (j >= 0 && s[j]._aabb.position.x > b._aabb.position.x) { s[j + 1] = s[j]; j--; } s[j + 1] = b; }
    for (let i = 0; i < s.length; i++) {
      const a = s[i]; const ax1 = a._aabb.position.x + a._aabb.size.x;
      for (let j = i + 1; j < s.length; j++) {
        const b = s[j]; if (b._aabb.position.x > ax1) break;
        const A = a._aabb, B = b._aabb;
        if (A.position.y > B.position.y + B.size.y || B.position.y > A.position.y + A.size.y || A.position.z > B.position.z + B.size.z || B.position.z > A.position.z + A.size.z) continue;
        cb(a, b);
      }
    }
  }
  _collide_bodies(a, b, out) {
    let n = 0;
    for (const sa of a._shapes) for (const sb of b._shapes) { if (sa.disabled || sb.disabled) continue; this.stats.pairs_tested++; n += collide_shapes(sa.shape, sa.world, sb.shape, sb.world, out); }
    return n;
  }
  step(dt) {
    if (dt <= 0) return;
    const bodies = this.bodies; const g = this.gravity_vector.mul(this.gravity);
    for (const b of bodies) b._sync_from_node(false);
    // integrate velocities
    let active = 0;
    for (const b of bodies) {
      if (b.mode !== BODY_RIGID || b.sleeping || b.freeze) continue; active++;
      const ld = Math.max(1 - (b.linear_damp + PhysicsSettings.default_linear_damp) * dt, 0), adm = Math.max(1 - (b.angular_damp + PhysicsSettings.default_angular_damp) * dt, 0);
      b.lv.iadd_scaled(g, b.gravity_scale * dt).iadd_scaled(b._force, b.inv_mass * dt).iscale(ld);
      b._update_inertia(); b.av.iadd(b._inv_I_world.xform(b._torque).mul(dt)).iscale(adm);
    }
    this.stats.active = active;
    for (const b of bodies) b._update_aabb(dt);
    // contacts
    const manifolds = []; const tmp = [];
    const seenPairs = new Set();
    this._broadphase((a, b) => {
      if (a.mode === BODY_AREA || b.mode === BODY_AREA) { this._area_pair(a, b); return; }
      const dynA = a.mode === BODY_RIGID && !a.freeze, dynB = b.mode === BODY_RIGID && !b.freeze;
      if (!dynA && !dynB) return;
      if ((!dynA || a.sleeping) && (!dynB || b.sleeping)) { // keep sleeping manifolds alive
        const key = a._uid < b._uid ? a._uid + ':' + b._uid : b._uid + ':' + a._uid; seenPairs.add(key); return;
      }
      if (!PhysicsSpace3D.can_collide(a, b) || a._excepts(b)) return;
      tmp.length = 0; if (!this._collide_bodies(a, b, tmp)) return;
      const key = a._uid < b._uid ? a._uid + ':' + b._uid : b._uid + ':' + a._uid; seenPairs.add(key);
      const A = a._uid < b._uid ? a : b, B = A === a ? b : a; const flip = A !== a;
      let m = this._pairs.get(key); const old = m ? m.contacts : null;
      m = { a: A, b: B, contacts: [] }; this._pairs.set(key, m);
      for (const c of tmp) {
        const n = flip ? c.n.neg() : c.n;
        const ct = { n, p: c.p, depth: c.depth, ra: c.p.sub(A.pos), rb: c.p.sub(B.pos), pn: 0, pt1: 0, pt2: 0, la: A._to_local(c.p) };
        if (old) for (const o of old) if (o.la.distance_squared_to(ct.la) < 0.0025) { ct.pn = o.pn * 0.9; ct.pt1 = o.pt1 * 0.9; ct.pt2 = o.pt2 * 0.9; break; }
        m.contacts.push(ct);
      }
      manifolds.push(m);
    });
    for (const k of [...this._pairs.keys()]) if (!seenPairs.has(k)) this._pairs.delete(k);
    this.stats.contacts = manifolds.reduce((s, m) => s + m.contacts.length, 0);
    this._solve(manifolds, dt);
    // integrate positions
    for (const b of bodies) {
      if (b.mode !== BODY_RIGID || b.sleeping || b.freeze) continue;
      b.pos.iadd_scaled(b.lv, dt);
      const w = b.av; const q = b.rot; const dq = new Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).mul(q);
      q.x += dq.x; q.y += dq.y; q.z += dq.z; q.w += dq.w; q.inormalize();
      b._force.set(0, 0, 0); b._torque.set(0, 0, 0);
      // sleeping
      if (b.can_sleep && b.lv.length() < PhysicsSettings.sleep_threshold_linear && b.av.length() < PhysicsSettings.sleep_threshold_angular) {
        b._sleep_time += dt; if (b._sleep_time >= PhysicsSettings.time_before_sleep) b._set_sleeping(true);
      } else b._sleep_time = 0;
      b._write_to_node();
    }
    this._contact_reports(manifolds);
    this._area_report();
  }
  _solve(manifolds, dt) {
    const S = PhysicsSettings; const t1 = _v(), t2 = _v(), tmpv = _v();
    const vel = (b, r, out) => { if (b.mode === BODY_RIGID && !b.sleeping && !b.freeze) { out.set_cross(b.av, r).iadd(b.lv); } else out.copy(b._kin_velocity()); return out; };
    const invM = (b) => (b.mode === BODY_RIGID && !b.sleeping && !b.freeze ? b.inv_mass : 0);
    const kfor = (b, r, n) => { if (!invM(b)) return 0; const rn = r.cross(n); return b._inv_I_world.xform(rn).cross(r).dot(n); };
    const apply = (b, r, imp, sgn) => { if (!invM(b)) return; b.lv.iadd_scaled(imp, sgn * b.inv_mass); b.av.iadd(b._inv_I_world.xform(r.cross(imp)).mul(sgn)); };
    // wake sleeping bodies hit by awake ones
    for (const m of manifolds) {
      const a = m.a, b = m.b;
      if (a.mode === BODY_RIGID && a.sleeping && b.mode === BODY_RIGID && !b.sleeping && b.lv.length() > S.sleep_threshold_linear) a._set_sleeping(false);
      if (b.mode === BODY_RIGID && b.sleeping && a.mode === BODY_RIGID && !a.sleeping && a.lv.length() > S.sleep_threshold_linear) b._set_sleeping(false);
    }
    const va = _v(), vb = _v(), dv = _v();
    for (const m of manifolds) {
      const a = m.a, b = m.b; a._update_inertia(); b._update_inertia();
      m.friction = a._combined_friction(b); m.bounce = a._combined_bounce(b);
      for (const c of m.contacts) {
        const n = c.n; const ia = invM(a), ib = invM(b);
        c.kn = 1 / Math.max(ia + ib + kfor(a, c.ra, n) + kfor(b, c.rb, n), 1e-12);
        // tangent basis
        if (Math.abs(n.x) > 0.57) t1.set(n.y, -n.x, 0); else t1.set(0, n.z, -n.y); t1.inormalize(); t2.set_cross(n, t1);
        c.t1 = t1.clone(); c.t2 = t2.clone();
        c.kt1 = 1 / Math.max(ia + ib + kfor(a, c.ra, c.t1) + kfor(b, c.rb, c.t1), 1e-12); c.kt2 = 1 / Math.max(ia + ib + kfor(a, c.ra, c.t2) + kfor(b, c.rb, c.t2), 1e-12);
        dv.copy(vel(b, c.rb, vb)).isub(vel(a, c.ra, va)); const vn = dv.dot(n);
        c.target = vn < -S.bounce_threshold ? -m.bounce * vn : 0;
        c.bias = S.baumgarte / dt * Math.max(c.depth - S.contact_slop, 0);
        // warm start
        const P = tmpv.copy(n).iscale(c.pn).iadd_scaled(c.t1, c.pt1).iadd_scaled(c.t2, c.pt2);
        apply(a, c.ra, P, -1); apply(b, c.rb, P, 1);
      }
    }
    const imp = _v();
    for (let it = 0; it < S.solver_iterations; it++) {
      for (const m of manifolds) {
        const a = m.a, b = m.b;
        for (const c of m.contacts) {
          // friction
          for (const [tk, kk, key] of [[c.t1, c.kt1, 'pt1'], [c.t2, c.kt2, 'pt2']]) {
            dv.copy(vel(b, c.rb, vb)).isub(vel(a, c.ra, va)); const vt = dv.dot(tk);
            let lam = -vt * kk; const maxF = m.friction * c.pn; const old = c[key]; c[key] = MathUtil.clamp(old + lam, -maxF, maxF); lam = c[key] - old;
            imp.copy(tk).iscale(lam); apply(a, c.ra, imp, -1); apply(b, c.rb, imp, 1);
          }
          dv.copy(vel(b, c.rb, vb)).isub(vel(a, c.ra, va)); const vn = dv.dot(c.n);
          let lam = (Math.max(c.target, c.bias) - vn) * c.kn; const old = c.pn; c.pn = Math.max(old + lam, 0); lam = c.pn - old;
          imp.copy(c.n).iscale(lam); apply(a, c.ra, imp, -1); apply(b, c.rb, imp, 1);
        }
      }
    }
  }
  _contact_reports(manifolds) {
    const now_sets = new Map();
    for (const m of manifolds) {
      for (const [x, y] of [[m.a, m.b], [m.b, m.a]]) {
        if (!x.contact_monitor) continue; let s = now_sets.get(x); if (!s) now_sets.set(x, (s = new Set())); s.add(y);
      }
    }
    for (const b of this.bodies) {
      if (!b.contact_monitor) continue; const prev = b._contact_set || new Set(); const cur = now_sets.get(b) || new Set();
      // sleeping pairs keep their contacts
      for (const o of prev) if (!cur.has(o) && b.sleeping && o.mode !== BODY_RIGID) cur.add(o);
      b._contact_set = cur;
      const limit = b.max_contacts_reported; if (limit <= 0) continue;
      for (const o of cur) if (!prev.has(o) && o._node && !o._node._freed) b._queue_signal('body_entered', o._node);
      for (const o of prev) if (!cur.has(o) && o._node && !o._node._freed) b._queue_signal('body_exited', o._node);
    }
  }
  _area_pair(a, b) {
    const area = a.mode === BODY_AREA ? a : b, other = area === a ? b : a;
    if (!area.monitoring) return;
    if (other.mode === BODY_AREA && !other.monitorable) return;
    if (!(area.collision_mask & other.collision_layer)) return;
    const tmp = []; if (!this._collide_bodies(area, other, tmp)) return;
    area._overlaps_now.add(other);
    if (other.mode === BODY_AREA && other.monitoring && (other.collision_mask & area.collision_layer) && area.monitorable) other._overlaps_now.add(area);
  }
  _area_report() {
    for (const b of this.bodies) {
      if (b.mode !== BODY_AREA) continue;
      const prev = b._overlaps, cur = b._overlaps_now; b._overlaps = cur; b._overlaps_now = new Set();
      for (const o of cur) if (!prev.has(o)) b._queue_signal(o.mode === BODY_AREA ? 'area_entered' : 'body_entered', o._node);
      for (const o of prev) if (!cur.has(o)) b._queue_signal(o.mode === BODY_AREA ? 'area_exited' : 'body_exited', o._node);
    }
    for (const b of this.bodies) b._flush_signals();
  }
  // ── queries
  intersect_ray(params) {
    const from = params.from, to = params.to; const dir = to.sub(from); const len = dir.length(); if (len === 0) return {};
    const d = dir.div(len); let best = null;
    for (const b of this.bodies) {
      if (!(b.collision_layer & params.collision_mask)) continue;
      if (b.mode === BODY_AREA ? !params.collide_with_areas : !params.collide_with_bodies) continue;
      if (params._exclude_set && params._exclude_set.has(b)) continue;
      b._sync_from_node(false); b._update_aabb(0);
      if (!b._aabb.intersects_ray(from, d) && !b._aabb.has_point(from)) continue;
      for (let si = 0; si < b._shapes.length; si++) {
        const s = b._shapes[si]; if (s.disabled) continue; const st = _shape_type(s.shape); let h = null;
        const maxT = best ? best.t : len;
        if (st === SHAPE_SPHERE) h = _ray_sphere(from, d, s.world.origin, s.shape._radius, maxT);
        else if (st === SHAPE_BOX) h = _ray_box(from, d, s.world, s.shape._size.mul(0.5), maxT);
        else if (st === SHAPE_CAPSULE) h = _ray_capsule(from, d, s.shape, s.world, maxT);
        else if (st === SHAPE_PLANE) h = _ray_plane(from, d, _world_plane(s.shape, s.world), maxT);
        if (h && (!best || h.t < best.t)) best = { t: h.t, n: h.n, body: b, shape: si };
      }
    }
    if (!best) return {};
    return { position: from.add(d.mul(best.t)), normal: best.n, collider: best.body._node, collider_id: best.body._node.get_instance_id(), shape: best.shape, rid: best.body._uid, face_index: -1 };
  }
  intersect_shape(params, max_results = 32) {
    const probe = new _QueryBody(params.shape, params.transform, params.collision_mask); probe._update_aabb(0);
    const res = []; const tmp = [];
    for (const b of this.bodies) {
      if (res.length >= max_results) break;
      if (!(b.collision_layer & params.collision_mask)) continue;
      if (b.mode === BODY_AREA ? !params.collide_with_areas : !params.collide_with_bodies) continue;
      if (params._exclude_set && params._exclude_set.has(b)) continue;
      b._sync_from_node(false); b._update_aabb(0); if (!b._aabb.intersects(probe._aabb) && b._shapes.every((s) => _shape_type(s.shape) !== SHAPE_PLANE)) continue;
      for (let si = 0; si < b._shapes.length; si++) { tmp.length = 0; if (collide_shapes(probe._shapes[0].shape, probe._shapes[0].world, b._shapes[si].shape, b._shapes[si].world, tmp)) { res.push({ collider: b._node, collider_id: b._node.get_instance_id(), shape: si, rid: b._uid }); break; } }
    }
    return res;
  }
  intersect_point(params, max_results = 32) {
    const q = new PhysicsShapeQueryParameters3D(); const s = new SphereShape3D(); s.radius = 1e-4; q.shape = s; q.transform = new Transform3D(new Basis(), params.position);
    q.collision_mask = params.collision_mask; q.collide_with_areas = params.collide_with_areas; q.collide_with_bodies = params.collide_with_bodies; q.exclude = params.exclude;
    const r = this.intersect_shape(q, max_results); s.dispose(); return r;
  }
}
let _bodyUid = 1;
// Engine-side body record (one per CollisionObject3D).
class _PBody {
  constructor(node, mode) {
    this._node = node; this.mode = mode; this._uid = _bodyUid++; this._space = null;
    this.collision_layer = 1; this.collision_mask = 1; this.pos = new Vector3(); this.rot = new Quaternion(); this._basis = new Basis(); this._T = new Transform3D();
    this.lv = new Vector3(); this.av = new Vector3(); this._force = new Vector3(); this._torque = new Vector3();
    this.inv_mass = 0; this._inv_I_local = new Vector3(); this._inv_I_world = new Basis().set_rows(0, 0, 0, 0, 0, 0, 0, 0, 0);
    this.gravity_scale = 1; this.linear_damp = 0; this.angular_damp = 0; this.can_sleep = true; this.sleeping = false; this._sleep_time = 0; this.freeze = false;
    this._shapes = []; this._aabb = new AABB(); this.contact_monitor = false; this.max_contacts_reported = 0;
    this.monitoring = true; this.monitorable = true; this._overlaps = new Set(); this._overlaps_now = new Set(); this._sigq = [];
    this._exceptions = null; this.material = null;
  }
  _excepts(o) { return (this._exceptions && this._exceptions.has(o)) || (o._exceptions && o._exceptions.has(this)); }
  _kin_velocity() { return this._node && this._node._kin_vel ? this._node._kin_vel() : Vector3.ZERO; }
  _to_local(p) { const d = p.sub(this.pos); return this.rot.inverse().xform(d); }
  _combined_friction(o) { const a = this.material, b = o.material; const fa = a ? a.friction : 1, fb = b ? b.friction : 1; const ra = !!(a && a.rough), rb = !!(b && b.rough); if (ra && rb) return Math.max(fa, fb); if (ra) return fa; if (rb) return fb; return Math.abs(Math.min(fa, fb)); }
  _combined_bounce(o) {
    const a = this.material, b = o.material; let ba = a ? a.bounce : 0, bb = b ? b.bounce : 0;
    if (a && a.absorbent) ba = -ba; if (b && b.absorbent) bb = -bb; return MathUtil.clamp(ba + bb, 0, 1);
  }
  _set_sleeping(s) { if (this.sleeping === s) return; this.sleeping = s; this._sleep_time = 0; if (s) { this.lv.set(0, 0, 0); this.av.set(0, 0, 0); } if (this._node) this._queue_signal('sleeping_state_changed'); }
  _queue_signal(name, ...args) { this._sigq.push(name, args); }
  _flush_signals() { const q = this._sigq; if (!q.length) return; this._sigq = []; for (let i = 0; i < q.length; i += 2) if (this._node && !this._node._freed) this._node.emit_signal(q[i], ...q[i + 1]); }
  _sync_from_node(force) {
    const n = this._node; if (!n) return;
    if (this.mode !== BODY_RIGID || force || n._phys_dirty) {
      const g = n._global_ref(); this.pos.copy(g.origin); this.rot = g.basis.get_rotation_quaternion(); n._phys_dirty = false;
    }
    this._basis.set_quaternion(this.rot); this._T.basis.copy(this._basis); this._T.origin.copy(this.pos);
    this._shapes = n._collect_shapes(this._T);
  }
  _update_inertia() {
    if (this.mode !== BODY_RIGID) return; const R = this._basis, I = this._inv_I_local;
    // R * diag(I) * R^T
    const r = (i, j) => R.el(i, j);
    const m = (i, j) => r(i, 0) * I.x * r(j, 0) + r(i, 1) * I.y * r(j, 1) + r(i, 2) * I.z * r(j, 2);
    this._inv_I_world.set_rows(m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(1, 1), m(1, 2), m(2, 0), m(2, 1), m(2, 2));
  }
  _update_aabb(dt) {
    let first = true; const tmp = new AABB();
    for (const s of this._shapes) { s.shape._local_aabb().xformed(s.world, tmp); if (first) { this._aabb.copy(tmp); first = false; } else this._aabb.copy(this._aabb.merge(tmp)); }
    if (first) { this._aabb.position.copy(this.pos); this._aabb.size.set(0, 0, 0); }
    if (dt > 0 && this.mode === BODY_RIGID) { // expand by motion for this step
      const m = this.lv.mul(dt); const a = this._aabb; const e = 0.02;
      a.position.set(a.position.x + Math.min(m.x, 0) - e, a.position.y + Math.min(m.y, 0) - e, a.position.z + Math.min(m.z, 0) - e);
      a.size.set(a.size.x + Math.abs(m.x) + 2 * e, a.size.y + Math.abs(m.y) + 2 * e, a.size.z + Math.abs(m.z) + 2 * e);
    }
  }
  _write_to_node() { const n = this._node; if (!n) return; n._physics_writing = true; n.global_transform = new Transform3D(Basis.from_quaternion(this.rot), this.pos); n._physics_writing = false; n._phys_dirty = false; }
}
class _QueryBody extends _PBody {
  constructor(shape, T, mask) { super(null, BODY_KINEMATIC); this.collision_mask = mask; this._shapes = [{ shape, world: T.orthonormalized(), disabled: false }]; this.pos.copy(T.origin); }
  _sync_from_node() {}
}

// ── Nodes
class CollisionShape3D extends Node3D {
  constructor(name) { super(name); this.shape = null; this.disabled = false; }
  _on_enter_tree_internal() { super._on_enter_tree_internal(); const p = this._parent; if (p instanceof CollisionObject3D) p._shapes_dirty = true; }
  _on_exit_tree_internal() { const p = this._parent; if (p instanceof CollisionObject3D) p._shapes_dirty = true; }
}
ClassDB.register(CollisionShape3D, 'CollisionShape3D', [{ name: 'shape', type: 'Resource' }, { name: 'disabled', type: 'bool' }]);

class CollisionObject3D extends Node3D {
  constructor(name, mode) {
    super(name); this._body = new _PBody(this, mode); this._shapes_dirty = true; this._shape_nodes = []; this._phys_dirty = true;
  }
  get collision_layer() { return this._body.collision_layer; } set collision_layer(v) { this._body.collision_layer = v >>> 0; }
  get collision_mask() { return this._body.collision_mask; } set collision_mask(v) { this._body.collision_mask = v >>> 0; }
  set_collision_layer_value(n, v) { const bit = 1 << (n - 1); this.collision_layer = v ? this.collision_layer | bit : this.collision_layer & ~bit; }
  get_collision_layer_value(n) { return (this.collision_layer & (1 << (n - 1))) !== 0; }
  set_collision_mask_value(n, v) { const bit = 1 << (n - 1); this.collision_mask = v ? this.collision_mask | bit : this.collision_mask & ~bit; }
  get_collision_mask_value(n) { return (this.collision_mask & (1 << (n - 1))) !== 0; }
  _propagate_xform_dirty() { const was = this._gdirty; super._propagate_xform_dirty(); if (!this._physics_writing) this._phys_dirty = true; }
  _changed_local() { super._changed_local(); if (!this._physics_writing) this._phys_dirty = true; }
  _collect_shapes(T) {
    if (this._shapes_dirty) { this._shape_nodes = this._children.filter((c) => c instanceof CollisionShape3D); this._shapes_dirty = false; }
    const out = []; const inv = this._global_ref().affine_inverse().orthonormalized();
    for (const sn of this._shape_nodes) {
      if (!sn.shape || sn._freed) continue;
      const off = sn._parent === this ? sn.transform.orthonormalized() : inv.mul(sn._global_ref()).orthonormalized();
      out.push({ shape: sn.shape, world: T.mul(off), disabled: sn.disabled, node: sn });
    }
    return out;
  }
  add_child(n, f) { super.add_child(n, f); if (n instanceof CollisionShape3D) this._shapes_dirty = true; }
  remove_child(n) { super.remove_child(n); if (n instanceof CollisionShape3D) this._shapes_dirty = true; }
  _on_enter_tree_internal() {
    super._on_enter_tree_internal(); const w = _world_of(this); if (!w) return;
    if (!w.space) w.space = new PhysicsSpace3D();
    this._shapes_dirty = true; w.space.add(this._body);
  }
  _on_exit_tree_internal() { if (this._body._space) this._body._space.remove(this._body); }
  get_rid() { return this._body._uid; }
}
ClassDB.register(CollisionObject3D, 'CollisionObject3D', [{ name: 'collision_layer', type: 'int' }, { name: 'collision_mask', type: 'int' }], { abstract: true });
class PhysicsBody3D extends CollisionObject3D {
  add_collision_exception_with(b) { (this._body._exceptions || (this._body._exceptions = new Set())).add(b._body); }
  remove_collision_exception_with(b) { if (this._body._exceptions) this._body._exceptions.delete(b._body); }
}
ClassDB.register(PhysicsBody3D, 'PhysicsBody3D', [], { abstract: true });
class StaticBody3D extends PhysicsBody3D {
  constructor(name) { super(name, BODY_STATIC); this.constant_linear_velocity = new Vector3(); this.constant_angular_velocity = new Vector3(); this._pm = null; }
  get physics_material_override() { return this._pm; } set physics_material_override(m) { this._pm = m; this._body.material = m; }
  _kin_vel() { return this.constant_linear_velocity; }
}
ClassDB.register(StaticBody3D, 'StaticBody3D', [{ name: 'constant_linear_velocity', type: 'Vector3' }, { name: 'physics_material_override', type: 'Resource' }]);

class RigidBody3D extends PhysicsBody3D {
  constructor(name) { super(name, BODY_RIGID); this._mass = 1; this._pm = null; this._body.inv_mass = 1; this._inertia_dirty = true; }
  get mass() { return this._mass; } set mass(m) { if (!(m > 0)) { Log.error('RigidBody3D.mass must be > 0'); return; } this._mass = m; this._inertia_dirty = true; }
  get physics_material_override() { return this._pm; } set physics_material_override(m) { this._pm = m; this._body.material = m; }
  get linear_velocity() { return this._body.lv.clone(); } set linear_velocity(v) { this._body.lv.copy(v); this._body._set_sleeping(false); }
  get angular_velocity() { return this._body.av.clone(); } set angular_velocity(v) { this._body.av.copy(v); this._body._set_sleeping(false); }
  get gravity_scale() { return this._body.gravity_scale; } set gravity_scale(v) { this._body.gravity_scale = v; }
  get linear_damp() { return this._body.linear_damp; } set linear_damp(v) { this._body.linear_damp = v; }
  get angular_damp() { return this._body.angular_damp; } set angular_damp(v) { this._body.angular_damp = v; }
  get can_sleep() { return this._body.can_sleep; } set can_sleep(v) { this._body.can_sleep = !!v; if (!v) this._body._set_sleeping(false); }
  get sleeping() { return this._body.sleeping; } set sleeping(v) { this._body._set_sleeping(!!v); }
  get freeze() { return this._body.freeze; } set freeze(v) { this._body.freeze = !!v; }
  get contact_monitor() { return this._body.contact_monitor; } set contact_monitor(v) { this._body.contact_monitor = !!v; }
  get max_contacts_reported() { return this._body.max_contacts_reported; } set max_contacts_reported(v) { this._body.max_contacts_reported = v | 0; }
  _sync_mass() {
    if (!this._inertia_dirty && !this._shapes_dirty) return; const b = this._body; b.inv_mass = 1 / this._mass;
    const shapes = this._collect_shapes(new Transform3D()); const m = this._mass; const I = new Vector3(0.4 * m * 0.25, 0.4 * m * 0.25, 0.4 * m * 0.25);
    if (shapes.length) {
      const s = shapes[0].shape;
      if (s instanceof BoxShape3D) { const x = s._size.x, y = s._size.y, z = s._size.z; I.set(m / 12 * (y * y + z * z), m / 12 * (x * x + z * z), m / 12 * (x * x + y * y)); }
      else if (s instanceof SphereShape3D) { const v = 0.4 * m * s._radius * s._radius; I.set(v, v, v); }
      else if (s instanceof CapsuleShape3D) { const r = s._radius, h = s._height; I.set(m * (3 * r * r + h * h) / 12, m * r * r / 2, m * (3 * r * r + h * h) / 12); }
      else if (s instanceof WorldBoundaryShape3D) Log.error('WorldBoundaryShape3D is only supported on static bodies');
    }
    b._inv_I_local.set(1 / I.x, 1 / I.y, 1 / I.z); this._inertia_dirty = false;
  }
  _collect_shapes(T) { const r = super._collect_shapes(T); return r; }
  _on_enter_tree_internal() { super._on_enter_tree_internal(); this._inertia_dirty = true; this._sync_mass(); }
  _wake() { this._sync_mass(); this._body._set_sleeping(false); this._body._sleep_time = 0; }
  apply_central_impulse(imp) { this._wake(); this._body.lv.iadd_scaled(imp, this._body.inv_mass); }
  apply_impulse(imp, pos = Vector3.ZERO) { this._wake(); this._body._update_inertia(); this._body.lv.iadd_scaled(imp, this._body.inv_mass); this._body.av.iadd(this._body._inv_I_world.xform(pos.cross(imp))); }
  apply_torque_impulse(imp) { this._wake(); this._body._update_inertia(); this._body.av.iadd(this._body._inv_I_world.xform(imp)); }
  apply_central_force(f) { this._wake(); this._body._force.iadd(f); }
  apply_force(f, pos = Vector3.ZERO) { this._wake(); this._body._force.iadd(f); this._body._torque.iadd(pos.cross(f)); }
  apply_torque(t) { this._wake(); this._body._torque.iadd(t); }
  get_contact_count() { return this._body._contact_set ? this._body._contact_set.size : 0; }
  get_colliding_bodies() { return this._body._contact_set ? [...this._body._contact_set].map((b) => b._node).filter(Boolean) : []; }
  _propagate_xform_dirty() { super._propagate_xform_dirty(); if (!this._physics_writing && this._body.sleeping) this._body._set_sleeping(false); }
}
RigidBody3D.signals = ['body_entered', 'body_exited', 'sleeping_state_changed'];
ClassDB.register(RigidBody3D, 'RigidBody3D', [{ name: 'mass', type: 'float' }, { name: 'physics_material_override', type: 'Resource' }, { name: 'linear_velocity', type: 'Vector3' }, { name: 'angular_velocity', type: 'Vector3' }, { name: 'gravity_scale', type: 'float' }, { name: 'linear_damp', type: 'float' }, { name: 'angular_damp', type: 'float' }, { name: 'can_sleep', type: 'bool' }, { name: 'freeze', type: 'bool' }, { name: 'contact_monitor', type: 'bool' }, { name: 'max_contacts_reported', type: 'int' }]);
// Space step runs before the shapes' inertia might be stale.
const _origStep = PhysicsSpace3D.prototype.step;
PhysicsSpace3D.prototype.step = function (dt) { for (const b of this.bodies) if (b._node instanceof RigidBody3D) b._node._sync_mass(); return _origStep.call(this, dt); };

class KinematicCollision3D {
  constructor(c, collider) { this._c = c; this._collider = collider; }
  get_position() { return this._c.p.clone(); } get_normal() { return this._c.n.clone(); } get_collider() { return this._collider; }
  get_depth() { return this._c.depth; } get_collider_id() { return this._collider ? this._collider.get_instance_id() : 0; }
  get_angle(up = Vector3.UP) { return Math.acos(MathUtil.clamp(this._c.n.dot(up), -1, 1)); }
}
// CharacterBody3D.move_and_slide: sub-stepped motion + iterative depenetration (not Godot's exact shape cast).
class CharacterBody3D extends PhysicsBody3D {
  constructor(name) {
    super(name, BODY_KINEMATIC); this.velocity = new Vector3(); this.up_direction = new Vector3(0, 1, 0);
    this.floor_max_angle = MathUtil.deg_to_rad(45); this.floor_snap_length = 0.1; this.max_slides = 6; this.floor_stop_on_slope = true;
    this._on_floor = false; this._on_wall = false; this._on_ceiling = false; this._floor_normal = new Vector3(); this._slides = []; this._real_velocity = new Vector3();
  }
  _kin_vel() { return this.velocity; }
  is_on_floor() { return this._on_floor; } is_on_wall() { return this._on_wall; } is_on_ceiling() { return this._on_ceiling; }
  is_on_floor_only() { return this._on_floor && !this._on_wall && !this._on_ceiling; }
  get_floor_normal() { return this._floor_normal.clone(); } get_real_velocity() { return this._real_velocity.clone(); }
  get_slide_collision_count() { return this._slides.length; } get_slide_collision(i) { return this._slides[i] || null; }
  get_last_slide_collision() { return this._slides.length ? this._slides[this._slides.length - 1] : null; }
  _contacts_now(out) {
    const sp = this._body._space; if (!sp) return; const me = this._body; me._sync_from_node(true); me._update_aabb(0);
    const tmp = [];
    for (const o of sp.bodies) {
      if (o === me || o.mode === BODY_AREA || !(me.collision_mask & o.collision_layer) || me._excepts(o)) continue;
      o._sync_from_node(false); o._update_aabb(0);
      if (!me._aabb.grow(0.01).intersects(o._aabb)) continue;
      tmp.length = 0; sp._collide_bodies(me, o, tmp); for (const c of tmp) out.push({ c, o });
    }
  }
  move_and_slide() {
    const dt = this.get_physics_process_delta_time() || 1 / Engine.physics_ticks_per_second;
    const start = this.global_position; const was_on_floor = this._on_floor;
    this._on_floor = this._on_wall = this._on_ceiling = false; this._slides = [];
    const cosFloor = Math.cos(this.floor_max_angle) - 1e-4; const up = this.up_direction;
    let motion = this.velocity.mul(dt);
    const ext = this._body._aabb.size; const minExt = Math.max(0.05, Math.min(ext.x || 1, ext.y || 1, ext.z || 1) * 0.4);
    const steps = Math.min(64, Math.max(1, Math.ceil(motion.length() / minExt)));
    const resolve = () => {
      for (let it = 0; it < this.max_slides; it++) {
        const cs = []; this._contacts_now(cs); if (!cs.length) return;
        let deepest = null; for (const x of cs) if (!deepest || x.c.depth > deepest.c.depth) deepest = x;
        if (deepest.c.depth < 1e-4) return;
        const n = deepest.c.n.neg(); // contact normal points from character to other; push opposite
        this.global_position = this.global_position.add(n.mul(deepest.c.depth));
        const kc = new KinematicCollision3D({ n, p: deepest.c.p, depth: deepest.c.depth }, deepest.o._node); this._slides.push(kc);
        const ndu = n.dot(up);
        if (ndu >= cosFloor) { this._on_floor = true; this._floor_normal = n.clone(); }
        else if (ndu <= -cosFloor) this._on_ceiling = true; else this._on_wall = true;
        const vn = this.velocity.dot(n);
        if (vn < 0) {
          if (ndu >= cosFloor && this.floor_stop_on_slope) { this.velocity = this.velocity.sub(n.mul(vn)); const vu = this.velocity.dot(up); if (Math.abs(vu) < 1e-3 || ndu > 0.999) this.velocity = this.velocity.sub(up.mul(vu)); }
          else this.velocity = this.velocity.sub(n.mul(vn));
          motion = this.velocity.mul(dt);
        }
      }
    };
    for (let s = 0; s < steps; s++) { this.global_position = this.global_position.add(motion.div(steps)); resolve(); }
    // floor snap: stick to the floor when walking down small steps / slopes
    if (!this._on_floor && was_on_floor && this.velocity.dot(up) <= 0 && this.floor_snap_length > 0) {
      const save = this.global_position; this.global_position = save.sub(up.mul(this.floor_snap_length));
      const cs = []; this._contacts_now(cs);
      const floorHit = cs.find((x) => x.c.n.neg().dot(up) >= cosFloor);
      if (floorHit) { resolve(); if (!this._on_floor) this.global_position = save; } else this.global_position = save;
    }
    this._real_velocity = this.global_position.sub(start).div(dt);
    return this._slides.length > 0;
  }
  // Godot API: returns KinematicCollision3D or null; moves until first collision (sub-stepped).
  move_and_collide(motion, test_only = false) {
    const start = this.global_position; const ext = this._body._aabb.size; const minExt = Math.max(0.02, Math.min(ext.x || 1, ext.y || 1, ext.z || 1) * 0.25);
    const steps = Math.min(128, Math.max(1, Math.ceil(motion.length() / minExt)));
    for (let s = 1; s <= steps; s++) {
      this.global_position = start.add(motion.mul(s / steps));
      const cs = []; this._contacts_now(cs); const hit = cs.find((x) => x.c.depth > 1e-4);
      if (hit) {
        let lo = (s - 1) / steps, hi = s / steps; // bisect to contact time
        for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; this.global_position = start.add(motion.mul(m)); const c2 = []; this._contacts_now(c2); if (c2.some((x) => x.c.depth > 1e-4)) hi = m; else lo = m; }
        this.global_position = start.add(motion.mul(lo));
        const kc = new KinematicCollision3D({ n: hit.c.n.neg(), p: hit.c.p, depth: hit.c.depth }, hit.o._node);
        if (test_only) this.global_position = start; return kc;
      }
    }
    if (test_only) this.global_position = start; return null;
  }
}
ClassDB.register(CharacterBody3D, 'CharacterBody3D', [{ name: 'velocity', type: 'Vector3' }, { name: 'up_direction', type: 'Vector3' }, { name: 'floor_max_angle', type: 'float' }, { name: 'floor_snap_length', type: 'float' }, { name: 'max_slides', type: 'int' }]);

class Area3D extends CollisionObject3D {
  constructor(name) { super(name, BODY_AREA); }
  get monitoring() { return this._body.monitoring; } set monitoring(v) { this._body.monitoring = !!v; if (!v) { for (const o of this._body._overlaps) this._body._queue_signal(o.mode === BODY_AREA ? 'area_exited' : 'body_exited', o._node); this._body._overlaps = new Set(); this._body._flush_signals(); } }
  get monitorable() { return this._body.monitorable; } set monitorable(v) { this._body.monitorable = !!v; }
  get_overlapping_bodies() { return [...this._body._overlaps].filter((b) => b.mode !== BODY_AREA).map((b) => b._node); }
  get_overlapping_areas() { return [...this._body._overlaps].filter((b) => b.mode === BODY_AREA).map((b) => b._node); }
  has_overlapping_bodies() { return this.get_overlapping_bodies().length > 0; }
  overlaps_body(b) { return this._body._overlaps.has(b._body); }
  _on_exit_tree_internal() { super._on_exit_tree_internal(); this._body._overlaps = new Set(); }
}
Area3D.signals = ['body_entered', 'body_exited', 'area_entered', 'area_exited'];
ClassDB.register(Area3D, 'Area3D', [{ name: 'monitoring', type: 'bool' }, { name: 'monitorable', type: 'bool' }]);

// Removing a body from the space must also emit exit signals on areas overlapping it.
const _origRemove = PhysicsSpace3D.prototype.remove;
PhysicsSpace3D.prototype.remove = function (b) {
  for (const o of this.bodies) if (o.mode === BODY_AREA && o._overlaps.has(b) && b._node) { o._overlaps.delete(b); if (o._node && !o._node._freed) o._node.emit_signal(b.mode === BODY_AREA ? 'area_exited' : 'body_exited', b._node); }
  return _origRemove.call(this, b);
};

class PhysicsRayQueryParameters3D {
  constructor() { this.from = new Vector3(); this.to = new Vector3(); this.collision_mask = 0xFFFFFFFF; this.collide_with_bodies = true; this.collide_with_areas = false; this.hit_from_inside = false; this._exclude = []; this._exclude_set = null; }
  static create(from, to, mask = 0xFFFFFFFF, exclude = []) { const p = new PhysicsRayQueryParameters3D(); p.from = from.clone(); p.to = to.clone(); p.collision_mask = mask; p.exclude = exclude; return p; }
  get exclude() { return this._exclude; } set exclude(a) { this._exclude = a; this._exclude_set = new Set(a.map((x) => (x instanceof CollisionObject3D ? x._body : x))); }
}
class PhysicsShapeQueryParameters3D {
  constructor() { this.shape = null; this.transform = new Transform3D(); this.collision_mask = 0xFFFFFFFF; this.collide_with_bodies = true; this.collide_with_areas = false; this.margin = 0; this._exclude = []; this._exclude_set = null; }
  get exclude() { return this._exclude; } set exclude(a) { this._exclude = a || []; this._exclude_set = new Set(this._exclude.map((x) => (x instanceof CollisionObject3D ? x._body : x))); }
}
class PhysicsPointQueryParameters3D { constructor() { this.position = new Vector3(); this.collision_mask = 0xFFFFFFFF; this.collide_with_bodies = true; this.collide_with_areas = false; this.exclude = []; } }
class PhysicsDirectSpaceState3D {
  constructor(space) { this._space = space; }
  intersect_ray(p) { return this._space.intersect_ray(p); }
  intersect_shape(p, max = 32) { return this._space.intersect_shape(p, max); }
  intersect_point(p, max = 32) { return this._space.intersect_point(p, max); }
}
Node3D.prototype.get_world_3d = function () { const w = _world_of(this); if (w && !w.space) w.space = new PhysicsSpace3D(); return w ? { direct_space_state: new PhysicsDirectSpaceState3D(w.space), space: w.space } : null; };

// Physics stepping: after nodes' _physics_process (as in Godot's iteration order).
SceneTreeHooks.physics_post.push((tree, delta) => {
  const w = tree.root._world_3d; if (w && w.space) w.space.step(delta);
});
Performance._providers.push((id) => {
  if (id === Performance.PHYSICS_3D_ACTIVE_OBJECTS || id === Performance.PHYSICS_3D_COLLISION_PAIRS) {
    const ml = Engine.get_main_loop(); const w = ml && ml.root && ml.root._world_3d; if (!w || !w.space) return 0;
    return id === Performance.PHYSICS_3D_ACTIVE_OBJECTS ? w.space.stats.active : w.space._pairs.size;
  }
  return undefined;
});

Object.assign(_ext, {
  PhysicsSettings, Shape3D, BoxShape3D, SphereShape3D, CapsuleShape3D, WorldBoundaryShape3D, PhysicsMaterial, CollisionShape3D, CollisionObject3D,
  PhysicsBody3D, StaticBody3D, RigidBody3D, CharacterBody3D, Area3D, KinematicCollision3D, PhysicsRayQueryParameters3D, PhysicsShapeQueryParameters3D,
  PhysicsPointQueryParameters3D, PhysicsDirectSpaceState3D, PhysicsSpace3D, collide_shapes,
});

// §8 ─────────────────────────────────────────────────────────────────────────
const _SK = 0x400000; // Godot KEY_SPECIAL
const Key = Object.freeze({
  KEY_NONE: 0, KEY_ESCAPE: _SK | 0x01, KEY_TAB: _SK | 0x02, KEY_BACKTAB: _SK | 0x03, KEY_BACKSPACE: _SK | 0x04, KEY_ENTER: _SK | 0x05, KEY_KP_ENTER: _SK | 0x06,
  KEY_INSERT: _SK | 0x07, KEY_DELETE: _SK | 0x08, KEY_PAUSE: _SK | 0x09, KEY_PRINT: _SK | 0x0A, KEY_HOME: _SK | 0x0D, KEY_END: _SK | 0x0E,
  KEY_LEFT: _SK | 0x0F, KEY_UP: _SK | 0x10, KEY_RIGHT: _SK | 0x11, KEY_DOWN: _SK | 0x12, KEY_PAGEUP: _SK | 0x13, KEY_PAGEDOWN: _SK | 0x14,
  KEY_SHIFT: _SK | 0x15, KEY_CTRL: _SK | 0x16, KEY_META: _SK | 0x17, KEY_ALT: _SK | 0x18, KEY_CAPSLOCK: _SK | 0x19, KEY_NUMLOCK: _SK | 0x1A, KEY_SCROLLLOCK: _SK | 0x1B,
  KEY_F1: _SK | 0x1C, KEY_SPACE: 32, KEY_0: 48, KEY_9: 57, KEY_A: 65, KEY_Z: 90,
});
const _keyNames = {}; for (let c = 65; c <= 90; c++) _keyNames['KEY_' + String.fromCharCode(c)] = c; for (let c = 48; c <= 57; c++) _keyNames['KEY_' + (c - 48)] = c;
for (let i = 1; i <= 12; i++) _keyNames['KEY_F' + i] = (_SK | 0x1C) + i - 1;
const KeyAll = Object.freeze(Object.assign({}, Key, _keyNames));
const _domSpecial = { Escape: KeyAll.KEY_ESCAPE, Tab: KeyAll.KEY_TAB, Backspace: KeyAll.KEY_BACKSPACE, Enter: KeyAll.KEY_ENTER, NumpadEnter: KeyAll.KEY_KP_ENTER, Insert: KeyAll.KEY_INSERT, Delete: KeyAll.KEY_DELETE,
  Pause: KeyAll.KEY_PAUSE, PrintScreen: KeyAll.KEY_PRINT, Home: KeyAll.KEY_HOME, End: KeyAll.KEY_END, ArrowLeft: KeyAll.KEY_LEFT, ArrowUp: KeyAll.KEY_UP, ArrowRight: KeyAll.KEY_RIGHT, ArrowDown: KeyAll.KEY_DOWN,
  PageUp: KeyAll.KEY_PAGEUP, PageDown: KeyAll.KEY_PAGEDOWN, ShiftLeft: KeyAll.KEY_SHIFT, ShiftRight: KeyAll.KEY_SHIFT, Shift: KeyAll.KEY_SHIFT, ControlLeft: KeyAll.KEY_CTRL, ControlRight: KeyAll.KEY_CTRL, Control: KeyAll.KEY_CTRL,
  MetaLeft: KeyAll.KEY_META, MetaRight: KeyAll.KEY_META, Meta: KeyAll.KEY_META, AltLeft: KeyAll.KEY_ALT, AltRight: KeyAll.KEY_ALT, Alt: KeyAll.KEY_ALT, CapsLock: KeyAll.KEY_CAPSLOCK, NumLock: KeyAll.KEY_NUMLOCK, ScrollLock: KeyAll.KEY_SCROLLLOCK, Space: 32, ' ': 32 };
for (let i = 1; i <= 12; i++) _domSpecial['F' + i] = KeyAll['KEY_F' + i];
const keycode_from_dom_code = (code) => {
  if (_domSpecial[code] !== undefined) return _domSpecial[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1].charCodeAt(0);
  m = /^(?:Digit|Numpad)(\d)$/.exec(code); if (m) return 48 + +m[1];
  const punct = { Minus: 45, Equal: 61, BracketLeft: 91, BracketRight: 93, Backslash: 92, Semicolon: 59, Quote: 39, Backquote: 96, Comma: 44, Period: 46, Slash: 47 };
  return punct[code] || 0;
};
const keycode_from_dom_key = (key) => {
  if (_domSpecial[key] !== undefined) return _domSpecial[key];
  if (key && key.length === 1) { const c = key.toUpperCase().charCodeAt(0); return c; }
  return 0;
};
const MouseButton = Object.freeze({ MOUSE_BUTTON_NONE: 0, MOUSE_BUTTON_LEFT: 1, MOUSE_BUTTON_RIGHT: 2, MOUSE_BUTTON_MIDDLE: 3, MOUSE_BUTTON_WHEEL_UP: 4, MOUSE_BUTTON_WHEEL_DOWN: 5, MOUSE_BUTTON_WHEEL_LEFT: 6, MOUSE_BUTTON_WHEEL_RIGHT: 7 });
const JoyButton = Object.freeze({ JOY_BUTTON_A: 0, JOY_BUTTON_B: 1, JOY_BUTTON_X: 2, JOY_BUTTON_Y: 3, JOY_BUTTON_BACK: 4, JOY_BUTTON_GUIDE: 5, JOY_BUTTON_START: 6, JOY_BUTTON_LEFT_STICK: 7, JOY_BUTTON_RIGHT_STICK: 8, JOY_BUTTON_LEFT_SHOULDER: 9, JOY_BUTTON_RIGHT_SHOULDER: 10, JOY_BUTTON_DPAD_UP: 11, JOY_BUTTON_DPAD_DOWN: 12, JOY_BUTTON_DPAD_LEFT: 13, JOY_BUTTON_DPAD_RIGHT: 14 });
const JoyAxis = Object.freeze({ JOY_AXIS_LEFT_X: 0, JOY_AXIS_LEFT_Y: 1, JOY_AXIS_RIGHT_X: 2, JOY_AXIS_RIGHT_Y: 3, JOY_AXIS_TRIGGER_LEFT: 4, JOY_AXIS_TRIGGER_RIGHT: 5 });
// W3C "standard" gamepad mapping -> Godot JoyButton (triggers 6/7 become axes).
const _stdButtonMap = [0, 1, 2, 3, 9, 10, -1, -1, 4, 6, 7, 8, 11, 12, 13, 14, 5];

class InputEvent extends Resource {
  constructor() { super(); this.device = 0; this._pressed = false; this._echo = false; }
  is_pressed() { return this._pressed; } is_echo() { return this._echo; }
  get pressed() { return this._pressed; } set pressed(v) { this._pressed = !!v; }
  get echo() { return this._echo; } set echo(v) { this._echo = !!v; }
  is_action_type() { return false; }
  is_action(action, exact = false) { return InputMap.event_is_action(this, action, exact); }
  is_action_pressed(action, allow_echo = false, exact = false) { const m = InputMap._match(this, action, exact); return !!m && m.pressed && (allow_echo || !this._echo); }
  is_action_released(action, exact = false) { const m = InputMap._match(this, action, exact); return !!m && !m.pressed; }
  get_action_strength(action, exact = false) { const m = InputMap._match(this, action, exact); return m ? m.strength : 0; }
  as_text() { return this.get_class(); }
  // Subclasses: _match_event(mapEvent, exact, deadzone) -> null | {pressed, strength}
  _match_event() { return null; }
  // DOM-free events are Resources but transient; release from ObjectDB eagerly after dispatch.
  _release() { if (!this._freed) this.dispose(); }
}
ClassDB.register(InputEvent, 'InputEvent', [], { abstract: true });
class InputEventWithModifiers extends InputEvent {
  constructor() { super(); this.shift_pressed = false; this.ctrl_pressed = false; this.alt_pressed = false; this.meta_pressed = false; }
  _mods_ok(m, exact) {
    const req = (a, b) => (exact ? a === b : !a || b);
    return req(m.shift_pressed, this.shift_pressed) && req(m.ctrl_pressed, this.ctrl_pressed) && req(m.alt_pressed, this.alt_pressed) && req(m.meta_pressed, this.meta_pressed);
  }
}
ClassDB.register(InputEventWithModifiers, 'InputEventWithModifiers', [{ name: 'shift_pressed', type: 'bool' }, { name: 'ctrl_pressed', type: 'bool' }, { name: 'alt_pressed', type: 'bool' }, { name: 'meta_pressed', type: 'bool' }], { abstract: true });
class InputEventKey extends InputEventWithModifiers {
  constructor() { super(); this.keycode = 0; this.physical_keycode = 0; this.key_label = 0; this.unicode = 0; }
  _match_event(m, exact) {
    if (!(m instanceof InputEventKey)) return null;
    const ok = m.keycode !== 0 ? m.keycode === this.keycode : (m.physical_keycode !== 0 ? m.physical_keycode === this.physical_keycode : false);
    if (!ok) return null;
    // Modifiers are ignored on release so the action is released even if modifiers changed (Godot behavior).
    if (this._pressed && !this._mods_ok(m, exact)) return null;
    return { pressed: this._pressed, strength: this._pressed ? 1 : 0 };
  }
  as_text() { return 'Key ' + (this.keycode || this.physical_keycode); }
}
ClassDB.register(InputEventKey, 'InputEventKey', [{ name: 'keycode', type: 'int' }, { name: 'physical_keycode', type: 'int' }, { name: 'pressed', type: 'bool' }]);
class InputEventMouse extends InputEventWithModifiers { constructor() { super(); this.button_mask = 0; this.position = new Vector2(); this.global_position = new Vector2(); } }
ClassDB.register(InputEventMouse, 'InputEventMouse', [], { abstract: true });
class InputEventMouseButton extends InputEventMouse {
  constructor() { super(); this.button_index = 0; this.factor = 1; this.double_click = false; this.canceled = false; }
  _match_event(m, exact) { if (!(m instanceof InputEventMouseButton) || m.button_index !== this.button_index) return null; if (this._pressed && !this._mods_ok(m, exact)) return null; return { pressed: this._pressed, strength: this._pressed ? 1 : 0 }; }
}
ClassDB.register(InputEventMouseButton, 'InputEventMouseButton', [{ name: 'button_index', type: 'int' }, { name: 'pressed', type: 'bool' }]);
class InputEventMouseMotion extends InputEventMouse { constructor() { super(); this.relative = new Vector2(); this.velocity = new Vector2(); this.pressure = 0; } }
ClassDB.register(InputEventMouseMotion, 'InputEventMouseMotion', []);
class InputEventScreenTouch extends InputEvent { constructor() { super(); this.index = 0; this.position = new Vector2(); this.double_tap = false; this.canceled = false; } }
ClassDB.register(InputEventScreenTouch, 'InputEventScreenTouch', []);
class InputEventScreenDrag extends InputEvent { constructor() { super(); this.index = 0; this.position = new Vector2(); this.relative = new Vector2(); this.velocity = new Vector2(); this.pressure = 0; } }
ClassDB.register(InputEventScreenDrag, 'InputEventScreenDrag', []);
class InputEventJoypadButton extends InputEvent {
  constructor() { super(); this.button_index = 0; this.pressure = 0; }
  _match_event(m) { if (!(m instanceof InputEventJoypadButton) || m.button_index !== this.button_index) return null; if (m.device !== -1 && m.device !== this.device) return null; return { pressed: this._pressed, strength: this._pressed ? 1 : 0 }; }
}
ClassDB.register(InputEventJoypadButton, 'InputEventJoypadButton', [{ name: 'button_index', type: 'int' }, { name: 'pressed', type: 'bool' }, { name: 'device', type: 'int' }]);
class InputEventJoypadMotion extends InputEvent {
  constructor() { super(); this.axis = 0; this.axis_value = 0; }
  is_pressed() { return Math.abs(this.axis_value) >= 0.5; }
  _match_event(m, exact, deadzone) {
    if (!(m instanceof InputEventJoypadMotion) || m.axis !== this.axis) return null; if (m.device !== -1 && m.device !== this.device) return null;
    if (exact && Math.sign(m.axis_value) !== Math.sign(this.axis_value) && this.axis_value !== 0) return null;
    // Same direction as the mapped event -> strength remapped from [deadzone,1] to [0,1]; opposite direction releases.
    if (this.axis_value * m.axis_value > 0) {
      const raw = Math.abs(this.axis_value); const pressed = raw >= deadzone;
      return { pressed, strength: pressed ? MathUtil.clamp(MathUtil.inverse_lerp(deadzone, 1, raw), 0, 1) : 0, raw };
    }
    return { pressed: false, strength: 0, raw: 0 };
  }
}
ClassDB.register(InputEventJoypadMotion, 'InputEventJoypadMotion', [{ name: 'axis', type: 'int' }, { name: 'axis_value', type: 'float' }, { name: 'device', type: 'int' }]);
class InputEventAction extends InputEvent {
  constructor() { super(); this.action = ''; this.strength = 1; }
  is_action_type() { return true; }
  _match_event() { return null; }
}
ClassDB.register(InputEventAction, 'InputEventAction', [{ name: 'action', type: 'string' }, { name: 'pressed', type: 'bool' }, { name: 'strength', type: 'float' }]);

const InputMap = {
  _actions: new Map(), // name -> { deadzone, events: [] }
  add_action(action, deadzone = 0.2) { if (this._actions.has(action)) { Log.error(`InputMap.add_action: action '${action}' already exists`); return; } this._actions.set(action, { deadzone, events: [] }); },
  erase_action(action) { if (!this._actions.delete(action)) Log.error(`InputMap.erase_action: unknown action '${action}'`); Input._action_states.delete(action); },
  has_action(a) { return this._actions.has(a); },
  get_actions() { return [...this._actions.keys()]; },
  action_add_event(action, ev) { const a = this._get(action); if (a && !a.events.includes(ev)) a.events.push(ev); },
  action_erase_event(action, ev) { const a = this._get(action); if (a) { const i = a.events.indexOf(ev); if (i >= 0) a.events.splice(i, 1); } },
  action_erase_events(action) { const a = this._get(action); if (a) a.events.length = 0; },
  action_get_events(action) { const a = this._get(action); return a ? a.events.slice() : []; },
  action_has_event(action, ev) { const a = this._get(action); return !!a && a.events.includes(ev); },
  action_set_deadzone(action, dz) { const a = this._get(action); if (a) a.deadzone = dz; },
  action_get_deadzone(action) { const a = this._get(action); return a ? a.deadzone : 0; },
  _get(action) { const a = this._actions.get(action); if (!a) Log.error(`InputMap: the InputMap action "${action}" doesn't exist`); return a; },
  _match(ev, action, exact = false) {
    if (ev instanceof InputEventAction) return ev.action === action ? { pressed: ev._pressed, strength: ev._pressed ? ev.strength : 0 } : null;
    const a = this._actions.get(action); if (!a) { Log.error(`InputMap: the InputMap action "${action}" doesn't exist`); return null; }
    for (const m of a.events) { const r = ev._match_event(m, exact, a.deadzone); if (r) return r; }
    return null;
  },
  event_is_action(ev, action, exact = false) { return !!this._match(ev, action, exact); },
  // Convenience for defining bindings in code: InputMap.bind('jump', {key: KEY_SPACE}, {joy_button: 0}).
  bind(action, ...specs) {
    if (!this.has_action(action)) this.add_action(action);
    for (const s of specs) {
      let e;
      if (s.key !== undefined || s.physical_key !== undefined) { e = new InputEventKey(); e.keycode = s.key || 0; e.physical_keycode = s.physical_key || 0; Object.assign(e, s.mods || {}); }
      else if (s.mouse_button !== undefined) { e = new InputEventMouseButton(); e.button_index = s.mouse_button; }
      else if (s.joy_button !== undefined) { e = new InputEventJoypadButton(); e.button_index = s.joy_button; e.device = s.device ?? -1; }
      else if (s.joy_axis !== undefined) { e = new InputEventJoypadMotion(); e.axis = s.joy_axis; e.axis_value = s.direction || 1; e.device = s.device ?? -1; }
      else throw new Error('InputMap.bind: unknown spec ' + JSON.stringify(s));
      this.action_add_event(action, e);
    }
  },
  clear() { this._actions.clear(); Input._action_states.clear(); },
};

// Input singleton: buffers DOM events and flushes them at the start of each engine iteration.
const Input = {
  _keys: new Set(), _phys_keys: new Set(), _mouse_buttons: new Set(), _mouse_pos: new Vector2(), _last_mouse_vel: new Vector2(),
  _action_states: new Map(), _buffer: [], _joy: new Map(), _attached: null, emulate_mouse_from_touch: true, emulate_touch_from_mouse: false,
  _gamepad_source: null, _signals_obj: null, use_accumulated_input: true,
  get signals() { return this._signals_obj; },
  is_key_pressed(k) { return this._keys.has(k); },
  is_physical_key_pressed(k) { return this._phys_keys.has(k); },
  is_mouse_button_pressed(b) { return this._mouse_buttons.has(b); },
  get_mouse_button_mask() { let m = 0; for (const b of this._mouse_buttons) m |= 1 << (b - 1); return m; },
  get_mouse_position() { return this._mouse_pos.clone(); },
  get_last_mouse_velocity() { return this._last_mouse_vel.clone(); },
  _state(a) { let s = this._action_states.get(a); if (!s) { s = { pressed: false, strength: 0, raw: 0, pp: -1, pproc: -1, rp: -1, rproc: -1, sources: new Map() }; this._action_states.set(a, s); } return s; },
  _check(action) { if (!InputMap._actions.has(action)) { Log.error(`Input: the InputMap action "${action}" doesn't exist`); return false; } return true; },
  is_action_pressed(action, exact = false) { if (!this._check(action)) return false; const s = this._action_states.get(action); return !!s && s.pressed; },
  is_action_just_pressed(action, exact = false) {
    if (!this._check(action)) return false; const s = this._action_states.get(action); if (!s || !s.pressed) return false;
    return Engine.is_in_physics_frame() ? s.pp === Engine.get_physics_frames() : s.pproc === Engine.get_process_frames();
  },
  is_action_just_released(action, exact = false) {
    if (!this._check(action)) return false; const s = this._action_states.get(action); if (!s || s.pressed) return false;
    return Engine.is_in_physics_frame() ? s.rp === Engine.get_physics_frames() : s.rproc === Engine.get_process_frames();
  },
  get_action_strength(action, exact = false) { if (!this._check(action)) return 0; const s = this._action_states.get(action); return s ? s.strength : 0; },
  get_action_raw_strength(action) { const s = this._action_states.get(action); return s ? s.raw : 0; },
  get_axis(neg, pos) { return this.get_action_strength(pos) - this.get_action_strength(neg); },
  // Same circular-deadzone remap as Godot's Input.get_vector.
  get_vector(nx, px, ny, py, deadzone = -1) {
    const v = new Vector2(this.get_action_raw_strength(px) - this.get_action_raw_strength(nx), this.get_action_raw_strength(py) - this.get_action_raw_strength(ny));
    if (deadzone < 0) deadzone = 0.25 * (InputMap.action_get_deadzone(px) + InputMap.action_get_deadzone(nx) + InputMap.action_get_deadzone(py) + InputMap.action_get_deadzone(ny));
    const len = v.length(); if (len <= deadzone) return new Vector2();
    if (len > 1) return v.div(len);
    return v.mul(MathUtil.inverse_lerp(deadzone, 1, len) / len);
  },
  action_press(action, strength = 1) { const e = new InputEventAction(); e.action = action; e._pressed = true; e.strength = strength; this.parse_input_event(e); },
  action_release(action) { const e = new InputEventAction(); e.action = action; e._pressed = false; this.parse_input_event(e); },
  is_joy_button_pressed(device, b) { const j = this._joy.get(device); return !!j && !!j.buttons[b]; },
  get_joy_axis(device, a) { const j = this._joy.get(device); return j ? j.axes[a] || 0 : 0; },
  get_connected_joypads() { return [...this._joy.keys()]; },
  get_joy_name(d) { const j = this._joy.get(d); return j ? j.name : ''; },
  // Queue an event; processed at the next flush (or immediately when no engine loop runs).
  parse_input_event(ev) { this._buffer.push(ev); },
  flush_buffered_events() {
    if (this._joy_poll) this._joy_poll();
    const buf = this._buffer; if (!buf.length) return; this._buffer = [];
    for (const ev of buf) { this._update_state(ev); this._dispatch(ev); }
  },
  _update_state(ev) {
    if (ev instanceof InputEventKey) { if (ev._pressed) { if (ev.keycode) this._keys.add(ev.keycode); if (ev.physical_keycode) this._phys_keys.add(ev.physical_keycode); } else { this._keys.delete(ev.keycode); this._phys_keys.delete(ev.physical_keycode); } }
    else if (ev instanceof InputEventMouseButton) { if (ev.button_index <= 3) { if (ev._pressed) this._mouse_buttons.add(ev.button_index); else this._mouse_buttons.delete(ev.button_index); } this._mouse_pos = ev.position.clone(); }
    else if (ev instanceof InputEventMouseMotion) { this._mouse_pos = ev.position.clone(); this._last_mouse_vel = ev.velocity.clone(); }
    else if (ev instanceof InputEventJoypadButton) { const j = this._joy_state(ev.device); j.buttons[ev.button_index] = ev._pressed; }
    else if (ev instanceof InputEventJoypadMotion) { const j = this._joy_state(ev.device); j.axes[ev.axis] = ev.axis_value; }
    const pf = Engine.get_physics_frames(), pr = Engine.get_process_frames();
    const apply = (action, m, srcKey) => {
      const s = this._state(action);
      // Multiple bound events: the action stays pressed while any source holds it.
      if (m.pressed) s.sources.set(srcKey, { strength: m.strength, raw: m.raw !== undefined ? m.raw : m.strength }); else s.sources.delete(srcKey);
      const was = s.pressed; let str = 0, raw = 0; for (const v of s.sources.values()) { str = Math.max(str, v.strength); raw = Math.max(raw, v.raw); }
      s.pressed = s.sources.size > 0; s.strength = str; s.raw = raw;
      if (s.pressed && !was) { s.pp = pf; s.pproc = pr; } else if (!s.pressed && was) { s.rp = pf; s.rproc = pr; }
    };
    if (ev instanceof InputEventAction) { if (InputMap._actions.has(ev.action)) apply(ev.action, { pressed: ev._pressed, strength: ev.strength }, 'action'); return; }
    if (ev._echo) return;
    for (const [name, a] of InputMap._actions) {
      for (const m of a.events) {
        const r = ev._match_event(m, false, a.deadzone);
        if (r) { apply(name, r, m); break; }
      }
    }
  },
  _joy_state(d) { let j = this._joy.get(d); if (!j) { j = { name: 'Joypad ' + d, buttons: [], axes: [], prev: null }; this._joy.set(d, j); } return j; },
  // Godot order: _input (reverse tree order) -> GUI -> _shortcut_input -> _unhandled_key_input -> _unhandled_input.
  _dispatch(ev) {
    const tree = Engine.get_main_loop(); if (!tree || !(tree instanceof SceneTree)) { ev._release(); return; }
    const vp = tree.root; vp._input_handled = false;
    if (tree._proc_dirty) tree._rebuild_process_lists();
    const nodes = tree._input_list.slice();
    for (let i = nodes.length - 1; i >= 0 && !vp._input_handled; i--) { const n = nodes[i]; if (n._input_enabled && !n._freed && n.can_process()) n._safe_call('_input', ev); }
    if (!vp._input_handled && typeof _gui_input_dispatch === 'function') _gui_input_dispatch(tree, ev);
    if (!vp._input_handled && ev instanceof InputEventKey) for (let i = nodes.length - 1; i >= 0 && !vp._input_handled; i--) { const n = nodes[i]; if (typeof n._shortcut_input === 'function' && !n._freed && n.can_process()) n._safe_call('_shortcut_input', ev); }
    if (!vp._input_handled && ev instanceof InputEventKey) for (let i = nodes.length - 1; i >= 0 && !vp._input_handled; i--) { const n = nodes[i]; if (typeof n._unhandled_key_input === 'function' && !n._freed && n.can_process()) n._safe_call('_unhandled_key_input', ev); }
    for (let i = nodes.length - 1; i >= 0 && !vp._input_handled; i--) { const n = nodes[i]; if (n._unhandled && !n._freed && n.can_process()) n._safe_call('_unhandled_input', ev); }
    ev._release();
  },
  // ── DOM bridging
  attach(target, canvas) {
    this.detach();
    const kbTarget = target || global; const cv = canvas || null; const L = [];
    const on = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); L.push([t, type, fn, opts]); };
    const mods = (e, de) => { e.shift_pressed = de.shiftKey; e.ctrl_pressed = de.ctrlKey; e.alt_pressed = de.altKey; e.meta_pressed = de.metaKey; };
    const key = (de, pressed) => {
      const e = new InputEventKey(); e._pressed = pressed; e._echo = !!de.repeat; e.keycode = keycode_from_dom_key(de.key); e.physical_keycode = keycode_from_dom_code(de.code);
      e.key_label = e.keycode; e.unicode = de.key && de.key.length === 1 ? de.key.codePointAt(0) : 0; mods(e, de); this.parse_input_event(e);
      if (this.prevent_default_keys && this.prevent_default_keys.has(de.code)) de.preventDefault();
    };
    on(kbTarget, 'keydown', (de) => key(de, true)); on(kbTarget, 'keyup', (de) => key(de, false));
    on(global, 'blur', () => { // release everything so keys don't stick when focus is lost
      for (const k of [...this._keys]) { const e = new InputEventKey(); e.keycode = k; e._pressed = false; this.parse_input_event(e); }
      for (const b of [...this._mouse_buttons]) { const e = new InputEventMouseButton(); e.button_index = b; e._pressed = false; this.parse_input_event(e); }
    });
    if (cv) {
      const pos = (de) => { const r = cv.getBoundingClientRect(); const sx = r.width ? cv.width / r.width : 1, sy = r.height ? cv.height / r.height : 1; return new Vector2((de.clientX - r.left) * sx, (de.clientY - r.top) * sy); };
      const touches = new Map(); let lastMouse = null, lastT = 0;
      const domBtn = [1, 3, 2];
      on(cv, 'pointerdown', (de) => {
        const p = pos(de);
        if (de.pointerType === 'touch') {
          const idx = touches.size ? Math.max(...touches.values()) + 1 : 0; touches.set(de.pointerId, idx);
          const e = new InputEventScreenTouch(); e.index = idx; e.position = p; e._pressed = true; this.parse_input_event(e);
          if (!(this.emulate_mouse_from_touch && idx === 0)) return;
        }
        if (cv.setPointerCapture && de.pointerId !== undefined) { try { cv.setPointerCapture(de.pointerId); } catch (err) { Log.verbose('setPointerCapture failed', err.message); } }
        const e = new InputEventMouseButton(); e.button_index = domBtn[de.button] || de.button + 1; e._pressed = true; e.position = p; e.global_position = p.clone(); e.double_click = de.detail === 2; mods(e, de); this.parse_input_event(e);
        lastMouse = p;
      });
      on(cv, 'pointerup', (de) => {
        const p = pos(de);
        if (de.pointerType === 'touch') {
          const idx = touches.get(de.pointerId); touches.delete(de.pointerId);
          const e = new InputEventScreenTouch(); e.index = idx ?? 0; e.position = p; e._pressed = false; this.parse_input_event(e);
          if (!(this.emulate_mouse_from_touch && idx === 0)) return;
        }
        const e = new InputEventMouseButton(); e.button_index = domBtn[de.button] || de.button + 1; e._pressed = false; e.position = p; e.global_position = p.clone(); mods(e, de); this.parse_input_event(e);
      });
      on(cv, 'pointercancel', (de) => { if (de.pointerType === 'touch') { const idx = touches.get(de.pointerId); touches.delete(de.pointerId); const e = new InputEventScreenTouch(); e.index = idx ?? 0; e.position = pos(de); e._pressed = false; e.canceled = true; this.parse_input_event(e); } });
      on(cv, 'pointermove', (de) => {
        const p = pos(de); const t = de.timeStamp || now();
        if (de.pointerType === 'touch') {
          const idx = touches.get(de.pointerId); if (idx === undefined) return;
          const e = new InputEventScreenDrag(); e.index = idx; e.position = p; e.relative = new Vector2(de.movementX || 0, de.movementY || 0); this.parse_input_event(e);
          if (!(this.emulate_mouse_from_touch && idx === 0)) return;
        }
        const e = new InputEventMouseMotion(); e.position = p; e.global_position = p.clone();
        e.relative = lastMouse ? p.sub(lastMouse) : new Vector2(de.movementX || 0, de.movementY || 0);
        const dt = (t - lastT) / 1000; e.velocity = dt > 0 && dt < 0.5 ? e.relative.div(dt) : new Vector2(); lastT = t; lastMouse = p;
        e.button_mask = de.buttons || 0; e.pressure = de.pressure || 0; mods(e, de); this.parse_input_event(e);
      });
      on(cv, 'wheel', (de) => {
        const p = pos(de); const btn = de.deltaY < 0 ? 4 : de.deltaY > 0 ? 5 : de.deltaX < 0 ? 6 : 7;
        for (const pressed of [true, false]) { const e = new InputEventMouseButton(); e.button_index = btn; e._pressed = pressed; e.position = p; e.factor = Math.min(Math.abs(de.deltaY || de.deltaX) / 100, 4) || 1; mods(e, de); this.parse_input_event(e); }
        de.preventDefault();
      }, { passive: false });
      on(cv, 'contextmenu', (de) => de.preventDefault());
      if (cv.style) cv.style.touchAction = 'none';
    }
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      on(global, 'gamepadconnected', (de) => Log.verbose('gamepad connected', de.gamepad.id));
    }
    this._attached = L; this.prevent_default_keys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    this._joy_poll = () => this._poll_gamepads();
  },
  detach() { if (!this._attached) return; for (const [t, type, fn, opts] of this._attached) t.removeEventListener(type, fn, opts); this._attached = null; this._joy_poll = null; },
  _poll_gamepads() {
    const src = this._gamepad_source || (typeof navigator !== 'undefined' && navigator.getGamepads ? () => navigator.getGamepads() : null);
    if (!src) return; const pads = src() || [];
    const seen = new Set();
    for (const gp of pads) {
      if (!gp || !gp.connected) continue; const d = gp.index; seen.add(d);
      const j = this._joy_state(d);
      if (!j.prev) { j.prev = { buttons: [], axes: [] }; j.name = gp.id; if (this._signals_obj) this._signals_obj.emit_signal('joy_connection_changed', d, true); }
      const std = gp.mapping === 'standard';
      gp.buttons.forEach((b, i) => {
        const pressed = typeof b === 'object' ? b.pressed : b > 0.5; const value = typeof b === 'object' ? b.value : +b;
        if (std && (i === 6 || i === 7)) { // triggers -> axes
          const ax = i === 6 ? JoyAxis.JOY_AXIS_TRIGGER_LEFT : JoyAxis.JOY_AXIS_TRIGGER_RIGHT;
          if (j.prev.axes[ax] !== value) { j.prev.axes[ax] = value; const e = new InputEventJoypadMotion(); e.device = d; e.axis = ax; e.axis_value = value; this.parse_input_event(e); }
          return;
        }
        const gb = std ? _stdButtonMap[i] : i; if (gb < 0 || gb === undefined) return;
        if (!!j.prev.buttons[gb] !== pressed) { j.prev.buttons[gb] = pressed; const e = new InputEventJoypadButton(); e.device = d; e.button_index = gb; e._pressed = pressed; e.pressure = value; this.parse_input_event(e); }
      });
      gp.axes.forEach((v, i) => { if (i > 3) return; if (j.prev.axes[i] !== v) { j.prev.axes[i] = v; const e = new InputEventJoypadMotion(); e.device = d; e.axis = i; e.axis_value = v; this.parse_input_event(e); } });
    }
    for (const d of [...this._joy.keys()]) if (!seen.has(d) && this._joy.get(d).prev) { this._joy.delete(d); if (this._signals_obj) this._signals_obj.emit_signal('joy_connection_changed', d, false); }
    // apply pending joypad events now so flush handles them in this iteration
  },
  reset() { this._keys.clear(); this._phys_keys.clear(); this._mouse_buttons.clear(); this._action_states.clear(); this._buffer.length = 0; this._joy.clear(); },
};
class _InputSignals extends GObject {} _InputSignals.signals = ['joy_connection_changed'];
Input._signals_obj = new _InputSignals();
// Flush input at the beginning of each engine iteration (before physics), polling gamepads first.
const _origIteration = Engine.iteration;
Engine.iteration = function (dt) {
  if (Input._joy_poll) Input._poll_gamepads();
  const buf = Input._buffer; if (buf.length) { Input._buffer = []; for (const ev of buf) { Input._update_state(ev); Input._dispatch(ev); } }
  return _origIteration.call(Engine, dt);
};
Node.prototype.set_process_input = function (b) { this._input_enabled = !!b; if (this._tree) this._tree._proc_dirty = true; };
Viewport.prototype.get_mouse_position = function () { return Input.get_mouse_position(); };
Viewport.prototype.push_input = function (ev) { Input._update_state(ev); Input._dispatch(ev); };

Object.assign(_ext, {
  Key: KeyAll, MouseButton, JoyButton, JoyAxis, InputEvent, InputEventWithModifiers, InputEventKey, InputEventMouse, InputEventMouseButton, InputEventMouseMotion,
  InputEventScreenTouch, InputEventScreenDrag, InputEventJoypadButton, InputEventJoypadMotion, InputEventAction, InputMap, Input,
  keycode_from_dom_code, keycode_from_dom_key,
});

// §9 ─────────────────────────────────────────────────────────────────────────
// Godot's @GlobalScope.ease(x, curve).
function ease(x, c) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  if (c > 0) return c < 1 ? 1 - Math.pow(1 - x, 1 / c) : Math.pow(x, c);
  if (c < 0) return x < 0.5 ? Math.pow(x * 2, -c) * 0.5 : (1 - Math.pow(1 - (x - 0.5) * 2, -c)) * 0.5 + 0.5;
  return 0;
}
MathUtil.ease = ease;
// Variant interpolation used by animation and tweens.
function interpolate_variant(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (a instanceof Quaternion) return a.slerp(b, t);
  if (a instanceof Transform3D) return a.interpolate_with(b, t);
  if (a instanceof Basis) return Basis.from_quaternion(a.get_rotation_quaternion().slerp(b.get_rotation_quaternion(), t)).scaled_local(a.get_scale().lerp(b.get_scale(), t));
  if (a instanceof Rect2) return new Rect2(a.position.lerp(b.position, t), a.size.lerp(b.size, t));
  if (a && typeof a.lerp === 'function') return a.lerp(b, t);
  return t < 1 ? a : b; // non-interpolatable: discrete (bool/string/object)
}
const _vadd = (a, b) => (typeof a === 'number' ? a + b : a.add(b));
const _vsub = (a, b) => (typeof a === 'number' ? a - b : a.sub(b));
const _vmul = (a, s) => (typeof a === 'number' ? a * s : a.mul(s));
function cubic_variant(pre, a, b, post, t) {
  if (typeof a === 'number') return MathUtil.cubic_interpolate(a, b, pre, post, t);
  if (a instanceof Vector2) return new Vector2(MathUtil.cubic_interpolate(a.x, b.x, pre.x, post.x, t), MathUtil.cubic_interpolate(a.y, b.y, pre.y, post.y, t));
  if (a instanceof Vector3) return new Vector3(MathUtil.cubic_interpolate(a.x, b.x, pre.x, post.x, t), MathUtil.cubic_interpolate(a.y, b.y, pre.y, post.y, t), MathUtil.cubic_interpolate(a.z, b.z, pre.z, post.z, t));
  if (a instanceof Color) return new Color(MathUtil.cubic_interpolate(a.r, b.r, pre.r, post.r, t), MathUtil.cubic_interpolate(a.g, b.g, pre.g, post.g, t), MathUtil.cubic_interpolate(a.b, b.b, pre.b, post.b, t), MathUtil.cubic_interpolate(a.a, b.a, pre.a, post.a, t));
  return interpolate_variant(a, b, t);
}
// Resolve "Node/Path:prop:sub" against a root node -> {obj, prop, sub[]}
function _resolve_property(root, path) {
  const np = path instanceof NodePath ? path : new NodePath(path);
  const node = np.get_name_count() ? root.get_node_or_null(new NodePath(np.get_concatenated_names())) : root;
  if (!node) return null;
  const subs = np.subnames.slice(); if (!subs.length) return { obj: node, node, prop: null, sub: [] };
  return { obj: node, node, prop: subs[0], sub: subs.slice(1) };
}
function _get_indexed(obj, prop, sub) { let v = obj[prop]; for (const s of sub) v = v[s]; return v; }
function _set_indexed(obj, prop, sub, val) {
  if (!sub.length) { obj[prop] = val; return; }
  const base = obj[prop]; const copy = base && typeof base.clone === 'function' ? base.clone() : base;
  let tgt = copy; for (let i = 0; i < sub.length - 1; i++) tgt = tgt[sub[i]];
  tgt[sub[sub.length - 1]] = val; obj[prop] = copy; // re-assign so setters (transform propagation) run
}

const TrackType = Object.freeze({ TYPE_VALUE: 0, TYPE_POSITION_3D: 1, TYPE_ROTATION_3D: 2, TYPE_SCALE_3D: 3, TYPE_BLEND_SHAPE: 4, TYPE_METHOD: 5, TYPE_BEZIER: 6, TYPE_AUDIO: 7, TYPE_ANIMATION: 8 });
const InterpolationType = Object.freeze({ INTERPOLATION_NEAREST: 0, INTERPOLATION_LINEAR: 1, INTERPOLATION_CUBIC: 2, INTERPOLATION_LINEAR_ANGLE: 3, INTERPOLATION_CUBIC_ANGLE: 4 });
const UpdateMode = Object.freeze({ UPDATE_CONTINUOUS: 0, UPDATE_DISCRETE: 1, UPDATE_CAPTURE: 2 });
const LoopMode = Object.freeze({ LOOP_NONE: 0, LOOP_LINEAR: 1, LOOP_PINGPONG: 2 });
const _SUPPORTED_TRACKS = new Set([0, 1, 2, 3, 5]);

class Animation extends Resource {
  constructor() { super(); this.length = 1; this.loop_mode = LoopMode.LOOP_NONE; this.step = 1 / 30; this._tracks = []; }
  add_track(type, at = -1) {
    if (!_SUPPORTED_TRACKS.has(type)) throw new RangeError(`Animation.add_track: track type ${type} is not supported by godot.js (supported: VALUE, POSITION_3D, ROTATION_3D, SCALE_3D, METHOD)`);
    const t = { type, path: new NodePath(''), keys: [], interp: InterpolationType.INTERPOLATION_LINEAR, update: UpdateMode.UPDATE_CONTINUOUS, enabled: true, loop_wrap: true };
    if (at < 0 || at >= this._tracks.length) { this._tracks.push(t); return this._tracks.length - 1; } this._tracks.splice(at, 0, t); return at;
  }
  remove_track(i) { this._tracks.splice(i, 1); }
  get_track_count() { return this._tracks.length; }
  track_get_type(i) { return this._tracks[i].type; }
  track_set_path(i, p) { this._tracks[i].path = p instanceof NodePath ? p : new NodePath(p); }
  track_get_path(i) { return this._tracks[i].path; }
  find_track(path, type) { const s = String(path); return this._tracks.findIndex((t) => String(t.path) === s && t.type === type); }
  track_set_enabled(i, b) { this._tracks[i].enabled = !!b; } track_is_enabled(i) { return this._tracks[i].enabled; }
  track_set_interpolation_type(i, t) { this._tracks[i].interp = t; } track_get_interpolation_type(i) { return this._tracks[i].interp; }
  track_set_interpolation_loop_wrap(i, b) { this._tracks[i].loop_wrap = !!b; }
  value_track_set_update_mode(i, m) { this._tracks[i].update = m; } value_track_get_update_mode(i) { return this._tracks[i].update; }
  track_insert_key(i, time, key, transition = 1) {
    const k = this._tracks[i].keys; const e = { time, value: key, transition };
    let j = k.findIndex((x) => x.time >= time);
    if (j >= 0 && Math.abs(k[j].time - time) < 1e-6) { k[j] = e; return j; }
    if (j < 0) { k.push(e); return k.length - 1; } k.splice(j, 0, e); return j;
  }
  // method track key: {method, args}
  track_get_key_count(i) { return this._tracks[i].keys.length; }
  track_get_key_value(i, k) { return this._tracks[i].keys[k].value; }
  track_get_key_time(i, k) { return this._tracks[i].keys[k].time; }
  track_set_key_value(i, k, v) { this._tracks[i].keys[k].value = v; }
  track_set_key_transition(i, k, t) { this._tracks[i].keys[k].transition = t; }
  track_remove_key(i, k) { this._tracks[i].keys.splice(k, 1); }
  position_track_insert_key(i, t, v) { return this.track_insert_key(i, t, v); }
  rotation_track_insert_key(i, t, q) { return this.track_insert_key(i, t, q); }
  scale_track_insert_key(i, t, v) { return this.track_insert_key(i, t, v); }
  method_track_get_name(i, k) { return this._tracks[i].keys[k].value.method; }
  // Sample a track at time; returns undefined when the track has no keys.
  _sample(t, time) {
    const k = t.keys; const n = k.length; if (!n) return undefined;
    const loop = this.loop_mode !== LoopMode.LOOP_NONE && t.loop_wrap;
    if (time <= k[0].time && !loop) return k[0].value;
    if (time >= k[n - 1].time && !loop) return k[n - 1].value;
    let i = -1; for (let j = n - 1; j >= 0; j--) if (k[j].time <= time) { i = j; break; }
    let a, b, ta, tb;
    if (i < 0) { if (!loop) return k[0].value; a = k[n - 1]; b = k[0]; ta = a.time - this.length; tb = b.time; }
    else if (i === n - 1) { if (!loop) return k[i].value; a = k[i]; b = k[0]; ta = a.time; tb = b.time + this.length; }
    else { a = k[i]; b = k[i + 1]; ta = a.time; tb = b.time; }
    if (n === 1) return a.value;
    const discrete = t.type === TrackType.TYPE_VALUE && (t.update === UpdateMode.UPDATE_DISCRETE || typeof a.value === 'boolean' || typeof a.value === 'string');
    if (discrete || t.interp === InterpolationType.INTERPOLATION_NEAREST) return a.value;
    let w = tb > ta ? (time - ta) / (tb - ta) : 0;
    if (a.transition !== 1) w = ease(w, a.transition);
    if (t.interp === InterpolationType.INTERPOLATION_LINEAR_ANGLE && typeof a.value === 'number') return MathUtil.lerp_angle(a.value, b.value, w);
    if (t.interp === InterpolationType.INTERPOLATION_CUBIC || t.interp === InterpolationType.INTERPOLATION_CUBIC_ANGLE) {
      const ia = k.indexOf(a), ib = k.indexOf(b);
      const pre = k[ia > 0 ? ia - 1 : loop ? n - 1 : ia].value, post = k[ib < n - 1 ? ib + 1 : loop ? 0 : ib].value;
      return cubic_variant(pre, a.value, b.value, post, w);
    }
    return interpolate_variant(a.value, b.value, w);
  }
  get tracks_data() { return this._tracks.map((t) => ({ type: t.type, path: String(t.path), interp: t.interp, update: t.update, enabled: t.enabled, loop_wrap: t.loop_wrap, keys: t.keys.map((k) => ({ time: k.time, value: k.value, transition: k.transition })) })); }
  set tracks_data(d) { this._tracks = d.map((t) => ({ type: t.type, path: new NodePath(t.path), interp: t.interp, update: t.update, enabled: t.enabled, loop_wrap: t.loop_wrap, keys: t.keys.map((k) => ({ time: k.time, value: k.value, transition: k.transition })) })); }
}
ClassDB.register(Animation, 'Animation', [{ name: 'length', type: 'float' }, { name: 'loop_mode', type: 'int' }, { name: 'step', type: 'float' }, { name: 'tracks_data', type: 'Array' }]);

class AnimationLibrary extends Resource {
  constructor() { super(); this._anims = new Map(); }
  add_animation(name, a) { this._anims.set(name, a); return Err.OK; }
  remove_animation(name) { this._anims.delete(name); }
  has_animation(name) { return this._anims.has(name); }
  get_animation(name) { return this._anims.get(name) || null; }
  get_animation_list() { return [...this._anims.keys()]; }
}
ClassDB.register(AnimationLibrary, 'AnimationLibrary', []);

const AnimationCallbackModeProcess = Object.freeze({ ANIMATION_CALLBACK_MODE_PROCESS_PHYSICS: 0, ANIMATION_CALLBACK_MODE_PROCESS_IDLE: 1, ANIMATION_CALLBACK_MODE_PROCESS_MANUAL: 2 });
class AnimationPlayer extends Node {
  constructor(name) {
    super(name); this._libs = new Map(); this.root_node = new NodePath('..'); this.speed_scale = 1; this.autoplay = '';
    this.callback_mode_process = 1; this._cur = null; this._cur_name = ''; this._pos = 0; this._playing = false; this._speed = 1; this._backwards = false;
    this._queue = []; this._ppdir = 1; this._assigned = '';
  }
  add_animation_library(name, lib) { if (this._libs.has(name)) return Err.ERR_ALREADY_EXISTS; this._libs.set(name, lib); return Err.OK; }
  remove_animation_library(name) { this._libs.delete(name); }
  get_animation_library(name) { return this._libs.get(name) || null; }
  get_animation_library_list() { return [...this._libs.keys()]; }
  // Convenience: adds to the default ("") library, creating it.
  add_animation(name, anim) { let l = this._libs.get(''); if (!l) { l = new AnimationLibrary(); this._libs.set('', l); } return l.add_animation(name, anim); }
  _split(name) { const i = name.indexOf('/'); return i >= 0 ? [name.slice(0, i), name.slice(i + 1)] : ['', name]; }
  has_animation(name) { const [l, a] = this._split(name); const lib = this._libs.get(l); return !!lib && lib.has_animation(a); }
  get_animation(name) { const [l, a] = this._split(name); const lib = this._libs.get(l); const r = lib ? lib.get_animation(a) : null; if (!r) Log.error(`AnimationPlayer: animation not found: ${name}`); return r; }
  get_animation_list() { const out = []; for (const [l, lib] of this._libs) for (const a of lib.get_animation_list()) out.push(l ? l + '/' + a : a); return out; }
  get current_animation() { return this._playing ? this._cur_name : ''; }
  set current_animation(n) { if (n) this.play(n); else this.stop(); }
  get assigned_animation() { return this._assigned; }
  get current_animation_position() { return this._pos; }
  get current_animation_length() { return this._cur ? this._cur.length : 0; }
  is_playing() { return this._playing; }
  get_playing_speed() { return this._playing ? this._speed * this.speed_scale : 0; }
  play(name = '', custom_blend = -1, custom_speed = 1, from_end = false) {
    if (!name) name = this._assigned; if (!name) { Log.error('AnimationPlayer.play: no animation'); return; }
    const anim = this.get_animation(name); if (!anim) return;
    const resume = this._assigned === name && !this._playing && this._cur === anim && this._pos > 0 && this._pos < anim.length && this._paused;
    this._cur = anim; this._cur_name = name; this._assigned = name; this._speed = custom_speed; this._paused = false; this._ppdir = 1;
    if (!resume) { this._pos = (from_end || custom_speed < 0) ? anim.length : 0; this._last_pos = this._pos - 1e-9 * Math.sign(custom_speed || 1); }
    this._playing = true; this._started = true; this._update_processing();
    this.emit_signal('animation_started', name);
    this._apply(this._pos, false);
  }
  play_backwards(name = '', custom_blend = -1) { this.play(name, custom_blend, -1, true); }
  pause() { this._playing = false; this._paused = true; this._update_processing(); }
  stop(keep_state = false) {
    this._playing = false; this._paused = false; this._queue = [];
    if (!keep_state && this._cur) { this._pos = 0; this._apply(0, false); }
    this._update_processing();
  }
  queue(name) { this._queue.push(name); }
  clear_queue() { this._queue = []; }
  get_queue() { return this._queue.slice(); }
  seek(seconds, update = false) { if (!this._cur) return; this._pos = MathUtil.clamp(seconds, 0, this._cur.length); this._last_pos = this._pos; if (update) this._apply(this._pos, false); }
  advance(delta) { this._step(delta); }
  _update_processing() {
    const p = this._playing; this.set_process_internal(p && this.callback_mode_process === 1); this.set_physics_process_internal(p && this.callback_mode_process === 0);
  }
  _internal_process(d) { this._step(d); }
  _internal_physics_process(d) { this._step(d); }
  _ready_autoplay() { if (this.autoplay && this.has_animation(this.autoplay)) this.play(this.autoplay); }
  _internal_notification(what) { super._internal_notification(what); if (what === NOTIFICATION.READY) this._ready_autoplay(); }
  _step(delta) {
    if (!this._playing || !this._cur) return;
    const a = this._cur; const sp = this._speed * this.speed_scale * this._ppdir; const L = a.length;
    let np = this._pos + delta * sp; let finished = false; const prev = this._pos;
    if (a.loop_mode === LoopMode.LOOP_LINEAR) {
      if (L > 0) { if (np >= L || np < 0) { this._fire_methods(prev, sp > 0 ? L : 0, sp > 0, true); const w = MathUtil.fposmod(np, L); this._fire_methods(sp > 0 ? 0 : L, w, sp > 0, false); this._pos = w; this._apply(w, true, true); return; } }
    } else if (a.loop_mode === LoopMode.LOOP_PINGPONG) {
      if (np >= L) { np = L - (np - L); this._ppdir = -this._ppdir; } else if (np < 0) { np = -np; this._ppdir = -this._ppdir; }
    } else if (np >= L || np <= 0 && sp < 0) { np = MathUtil.clamp(np, 0, L); finished = true; }
    this._fire_methods(prev, np, np >= prev, true);
    this._pos = np; this._apply(np, true, true);
    if (finished) {
      const name = this._cur_name; this._playing = false; this._update_processing();
      this.emit_signal('animation_finished', name);
      if (this._queue.length && !this._playing) this.play(this._queue.shift());
    }
  }
  _root() { return this.get_node_or_null(this.root_node); }
  _apply(time, from_step, skip_methods = false) {
    const a = this._cur; const root = this._root(); if (!a || !root) { if (!root) Log.error('AnimationPlayer: root_node not found'); return; }
    for (const t of a._tracks) {
      if (!t.enabled || t.type === TrackType.TYPE_METHOD) continue;
      const v = a._sample(t, time); if (v === undefined) continue;
      const r = _resolve_property(root, t.path); if (!r) { if (!this._warned) { Log.error('AnimationPlayer: track path not found', String(t.path)); this._warned = true; } continue; }
      if (t.type === TrackType.TYPE_POSITION_3D) r.node.position = v;
      else if (t.type === TrackType.TYPE_ROTATION_3D) r.node.quaternion = v;
      else if (t.type === TrackType.TYPE_SCALE_3D) r.node.scale = v;
      else if (r.prop) _set_indexed(r.obj, r.prop, r.sub, v);
    }
  }
  // Calls method-track keys whose time lies in (from, to] (forward) or [to, from) (backward).
  _fire_methods(from, to, forward, inclusive_end) {
    const a = this._cur; const root = this._root(); if (!a || !root) return;
    for (const t of a._tracks) {
      if (!t.enabled || t.type !== TrackType.TYPE_METHOD) continue;
      const r = _resolve_property(root, t.path); if (!r) continue;
      for (const k of t.keys) {
        const hit = forward ? (k.time > from && (inclusive_end ? k.time <= to : k.time < to)) || (from === 0 && k.time === 0 && this._started) : (k.time < from && k.time >= to);
        if (!hit) continue;
        const fn = r.node[k.value.method]; if (typeof fn !== 'function') { Log.error('AnimationPlayer: method not found', k.value.method); continue; }
        try { fn.apply(r.node, k.value.args || []); } catch (e) { Log.error('AnimationPlayer method track error', e); }
      }
    }
    this._started = false;
  }
}
AnimationPlayer.signals = ['animation_finished', 'animation_started', 'animation_changed', 'animation_libraries_updated'];
ClassDB.register(AnimationPlayer, 'AnimationPlayer', [{ name: 'root_node', type: 'NodePath' }, { name: 'speed_scale', type: 'float' }, { name: 'autoplay', type: 'string' }, { name: 'callback_mode_process', type: 'int' }]);

// ── Tween (Robert Penner easing equations, as used by Godot's Tween)
const TransitionType = Object.freeze({ TRANS_LINEAR: 0, TRANS_SINE: 1, TRANS_QUINT: 2, TRANS_QUART: 3, TRANS_QUAD: 4, TRANS_EXPO: 5, TRANS_ELASTIC: 6, TRANS_CUBIC: 7, TRANS_CIRC: 8, TRANS_BOUNCE: 9, TRANS_BACK: 10, TRANS_SPRING: 11 });
const EaseType = Object.freeze({ EASE_IN: 0, EASE_OUT: 1, EASE_IN_OUT: 2, EASE_OUT_IN: 3 });
const _bounceOut = (t) => { if (t < 1 / 2.75) return 7.5625 * t * t; if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; } if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; } t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375; };
const _easeIn = [
  (t) => t, (t) => 1 - Math.cos(t * Math.PI / 2), (t) => t ** 5, (t) => t ** 4, (t) => t * t, (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1)) - 0.001),
  (t) => { if (t === 0 || t === 1) return t; const p = 0.3, s = p / 4; t -= 1; return -(Math.pow(2, 10 * t) * Math.sin((t - s) * (2 * Math.PI) / p)); },
  (t) => t ** 3, (t) => -(Math.sqrt(1 - t * t) - 1), (t) => 1 - _bounceOut(1 - t), (t) => { const s = 1.70158; return t * t * ((s + 1) * t - s); },
  (t) => 1 - _springOut(1 - t),
];
function _springOut(t) { return (Math.sin(t * Math.PI * (0.2 + 2.5 * t * t * t)) * Math.pow(1 - t, 2.2) + t) * (1 + 1.2 * (1 - t)); }
function tween_interpolate(trans, easeType, t) {
  const fin = _easeIn[trans] || _easeIn[0];
  const fout = (x) => 1 - fin(1 - x);
  if (trans === TransitionType.TRANS_LINEAR) return t;
  if (trans === TransitionType.TRANS_BOUNCE) { const out = _bounceOut; const inn = (x) => 1 - out(1 - x); return easeType === 0 ? inn(t) : easeType === 1 ? out(t) : easeType === 2 ? (t < 0.5 ? inn(t * 2) / 2 : out(t * 2 - 1) / 2 + 0.5) : (t < 0.5 ? out(t * 2) / 2 : inn(t * 2 - 1) / 2 + 0.5); }
  if (trans === TransitionType.TRANS_SPRING) { const out = _springOut; const inn = (x) => 1 - out(1 - x); return easeType === 0 ? inn(t) : easeType === 1 ? out(t) : easeType === 2 ? (t < 0.5 ? inn(t * 2) / 2 : out(t * 2 - 1) / 2 + 0.5) : (t < 0.5 ? out(t * 2) / 2 : inn(t * 2 - 1) / 2 + 0.5); }
  switch (easeType) {
    case EaseType.EASE_IN: return fin(t);
    case EaseType.EASE_OUT: return fout(t);
    case EaseType.EASE_IN_OUT: return t < 0.5 ? fin(t * 2) / 2 : fout(t * 2 - 1) / 2 + 0.5;
    case EaseType.EASE_OUT_IN: return t < 0.5 ? fout(t * 2) / 2 : fin(t * 2 - 1) / 2 + 0.5;
  }
  return t;
}

class Tweener extends GObject {
  constructor() { super(); this._tween = null; this._elapsed = 0; this._done = false; this._delay = 0; this._started = false; }
  set_delay(d) { this._delay = d; return this; }
  _start() { this._elapsed = 0; this._done = false; this._started = false; }
}
Tweener.signals = ['finished'];
class PropertyTweener extends Tweener {
  constructor(obj, prop, final, duration) {
    super(); this._obj = obj; const r = prop.split(':'); this._prop = r[0]; this._sub = r.slice(1); this._final = final; this._duration = Math.max(0, duration);
    this._from = undefined; this._from_current = false; this._relative = false; this._trans = null; this._ease = null; this._custom = null;
  }
  from(v) { this._from = v; return this; }
  from_current() { this._from_current = true; return this; }
  as_relative() { this._relative = true; return this; }
  set_trans(t) { this._trans = t; return this; } set_ease(e) { this._ease = e; return this; }
  set_custom_interpolator(c) { this._custom = Callable.from(c); return this; }
  _step(dt) { // returns leftover time (>=0) when finished, -1 if still running
    if (this._obj._freed) { this._done = true; return dt; }
    this._elapsed += dt;
    if (this._elapsed < this._delay) return -1;
    if (!this._started) {
      this._started = true;
      const cur = _get_indexed(this._obj, this._prop, this._sub);
      this._initial = this._from !== undefined && !this._from_current ? this._from : cur;
      this._target = this._relative ? _vadd(this._initial, this._final) : this._final;
      if (this._from !== undefined && !this._from_current) _set_indexed(this._obj, this._prop, this._sub, this._from);
    }
    const t = this._elapsed - this._delay;
    if (t >= this._duration) { _set_indexed(this._obj, this._prop, this._sub, this._target); this._done = true; this.emit_signal('finished'); return t - this._duration; }
    let w = t / this._duration;
    w = this._custom ? this._custom.call(w) : tween_interpolate(this._trans ?? this._tween._trans, this._ease ?? this._tween._ease, w);
    _set_indexed(this._obj, this._prop, this._sub, interpolate_variant(this._initial, this._target, w));
    return -1;
  }
}
class IntervalTweener extends Tweener {
  constructor(t) { super(); this._duration = Math.max(0, t); }
  _step(dt) { this._elapsed += dt; if (this._elapsed >= this._duration) { this._done = true; this.emit_signal('finished'); return this._elapsed - this._duration; } return -1; }
}
class CallbackTweener extends Tweener {
  constructor(c) { super(); this._cb = Callable.from(c); }
  _step(dt) {
    this._elapsed += dt; if (this._elapsed < this._delay) return -1;
    try { this._cb.call(); } catch (e) { Log.error('Tween callback error', e); }
    this._done = true; this.emit_signal('finished'); return this._elapsed - this._delay;
  }
}
class MethodTweener extends Tweener {
  constructor(c, from, to, duration) { super(); this._cb = Callable.from(c); this._from = from; this._to = to; this._duration = Math.max(0, duration); this._trans = null; this._ease = null; }
  set_trans(t) { this._trans = t; return this; } set_ease(e) { this._ease = e; return this; }
  _step(dt) {
    this._elapsed += dt; if (this._elapsed < this._delay) return -1; const t = this._elapsed - this._delay;
    if (t >= this._duration) { this._cb.call(this._to); this._done = true; this.emit_signal('finished'); return t - this._duration; }
    const w = tween_interpolate(this._trans ?? this._tween._trans, this._ease ?? this._tween._ease, t / this._duration);
    this._cb.call(interpolate_variant(this._from, this._to, w)); return -1;
  }
}

const TweenProcessMode = Object.freeze({ TWEEN_PROCESS_PHYSICS: 0, TWEEN_PROCESS_IDLE: 1 });
const TweenPauseMode = Object.freeze({ TWEEN_PAUSE_BOUND: 0, TWEEN_PAUSE_STOP: 1, TWEEN_PAUSE_PROCESS: 2 });
class Tween extends GObject {
  constructor(tree) {
    super(); this._tree = tree; this._steps = []; this._parallel = false; this._next_parallel = false; this._loops = 1; this._loops_done = 0; this._cur = 0;
    this._running = true; this._valid = true; this._started = false; this._bound = null; this._speed = 1; this._trans = TransitionType.TRANS_LINEAR; this._ease = EaseType.EASE_IN_OUT;
    this._process_mode = TweenProcessMode.TWEEN_PROCESS_IDLE; this._pause_mode = TweenPauseMode.TWEEN_PAUSE_BOUND; this._ignore_time_scale = false; this._total = 0; this._dead = false;
  }
  _append(tw) {
    if (this._started && this._steps.length && this._cur >= this._steps.length) Log.warn('Tween: appending to a finished tween');
    tw._tween = this;
    if ((this._parallel || this._next_parallel) && this._steps.length) this._steps[this._steps.length - 1].push(tw); else this._steps.push([tw]);
    this._next_parallel = false; return tw;
  }
  tween_property(obj, prop, final, duration) {
    if (!obj || obj._freed) { Log.error('tween_property: invalid object'); return null; }
    const p = String(prop instanceof NodePath ? prop.get_concatenated_subnames() || prop : prop);
    if (_get_indexed(obj, p.split(':')[0], []) === undefined) { Log.error(`tween_property: property '${p}' not found on ${obj}`); return null; }
    return this._append(new PropertyTweener(obj, p, final, duration));
  }
  tween_interval(t) { return this._append(new IntervalTweener(t)); }
  tween_callback(c) { return this._append(new CallbackTweener(c)); }
  tween_method(c, from, to, duration) { return this._append(new MethodTweener(c, from, to, duration)); }
  set_parallel(p = true) { this._parallel = !!p; return this; }
  parallel() { this._next_parallel = true; return this; }
  chain() { this._next_parallel = false; this._chain_next = true; return this; }
  set_loops(n = 0) { this._loops = n; return this; }
  get_loops_left() { return this._loops <= 0 ? -1 : this._loops - this._loops_done; }
  set_speed_scale(s) { this._speed = s; return this; }
  set_trans(t) { this._trans = t; return this; } set_ease(e) { this._ease = e; return this; }
  set_process_mode(m) { this._process_mode = m; return this; }
  set_pause_mode(m) { this._pause_mode = m; return this; }
  set_ignore_time_scale(b = true) { this._ignore_time_scale = !!b; return this; }
  bind_node(n) { this._bound = n; (n._tweens || (n._tweens = [])).push(this); return this; }
  is_running() { return this._running && this._valid; }
  is_valid() { return this._valid && !this._dead && (!this._bound || !this._bound._freed); }
  pause() { this._running = false; } play() { this._running = true; }
  stop() { this._running = false; this._cur = 0; this._loops_done = 0; this._started = false; this._total = 0; for (const s of this._steps) for (const tw of s) tw._start(); }
  kill() { this._valid = false; this._running = false; this._dead = true; }
  get_total_elapsed_time() { return this._total; }
  // Tweens are owned by the tree; release engine objects once dead (the JS object stays inert/invalid).
  _release() {
    if (this._freed) return;
    if (this._bound && this._bound._tweens) { const i = this._bound._tweens.indexOf(this); if (i >= 0) this._bound._tweens.splice(i, 1); }
    for (const s of this._steps) for (const tw of s) if (!tw._freed) tw.free();
    this._valid = false; this.free();
  }
  _can_process(paused) {
    if (!this._running) return false;
    if (this._pause_mode === TweenPauseMode.TWEEN_PAUSE_PROCESS) return true;
    if (this._pause_mode === TweenPauseMode.TWEEN_PAUSE_BOUND && this._bound) return this._bound.can_process();
    return !paused;
  }
  custom_step(delta) { const r = this._running; this._running = true; const ok = this._step(delta); this._running = r && this._valid; return ok; }
  // Steps run sequentially; tweeners within a step in parallel; leftover time carries into the next step.
  _step(delta) {
    if (!this.is_valid()) return false;
    if (!this._started) {
      if (!this._steps.length) { Log.error('Tween without commands, aborting.'); this.kill(); return false; }
      this._started = true; for (const s of this._steps) for (const tw of s) tw._start();
    }
    let rem = delta * this._speed; this._total += rem; let guard = 0;
    while (rem >= 0 && this._valid) {
      if (++guard > 10000) { Log.error('Tween: infinite loop detected (zero-duration loop)'); this.kill(); return false; }
      const step = this._steps[this._cur];
      let all = true, leftover = Infinity;
      for (const tw of step) { if (tw._done) continue; const l = tw._step(rem); if (l < 0) all = false; else leftover = Math.min(leftover, l); }
      if (!all) return true;
      this.emit_signal('step_finished', this._cur);
      rem = leftover === Infinity ? rem : leftover;
      this._cur++;
      if (this._cur >= this._steps.length) {
        this._loops_done++;
        if (this._loops > 0 && this._loops_done >= this._loops) { this._valid = false; this._running = false; this.emit_signal('finished'); return false; }
        this.emit_signal('loop_finished', this._loops_done);
        this._cur = 0; for (const s of this._steps) for (const tw of s) tw._start();
        if (rem === 0 && delta === 0) return true;
      }
      if (rem === 0) { // let zero-duration tweeners (callbacks) at the start of the next step run now
        const nxt = this._steps[this._cur]; if (!nxt.every((tw) => tw instanceof CallbackTweener || (tw._duration === 0 && tw._delay === 0))) return true;
      }
    }
    return true;
  }
  static interpolate_value(initial, delta, elapsed, duration, trans, ease_t) {
    if (duration <= 0) return _vadd(initial, delta);
    const w = tween_interpolate(trans, ease_t, MathUtil.clamp(elapsed / duration, 0, 1)); return _vadd(initial, _vmul(delta, w));
  }
}
Tween.signals = ['finished', 'loop_finished', 'step_finished'];
ClassDB.register(Tween, 'Tween', [], { abstract: true });

// ── Timer node
const TimerProcessCallback = Object.freeze({ TIMER_PROCESS_PHYSICS: 0, TIMER_PROCESS_IDLE: 1 });
class Timer extends Node {
  constructor(name) { super(name); this.wait_time = 1; this.one_shot = false; this.autostart = false; this._time_left = -1; this._paused = false; this._cb = 1; this.ignore_time_scale = false; }
  get time_left() { return Math.max(this._time_left, 0); }
  get paused() { return this._paused; } set paused(p) { this._paused = !!p; this._sync(); }
  get process_callback() { return this._cb; } set process_callback(c) { this._cb = c; this._sync(); }
  start(t = -1) { if (t > 0) this.wait_time = t; if (!this._tree) { Log.error('Timer was not added to the SceneTree. Either add it or set autostart to true.'); return; } this._time_left = this.wait_time; this._sync(); }
  stop() { this._time_left = -1; this._sync(); }
  is_stopped() { return this._time_left <= 0; }
  _sync() { const on = this._time_left > 0 && !this._paused; this.set_process_internal(on && this._cb === 1); this.set_physics_process_internal(on && this._cb === 0); }
  _tick(delta) {
    if (this._time_left <= 0 || this._paused) return;
    if (this.ignore_time_scale && Engine.time_scale > 0) delta /= Engine.time_scale;
    this._time_left -= delta;
    if (this._time_left < 0) { // strict "< 0" like Godot's Timer
      if (!this.one_shot) this._time_left += this.wait_time; else this.stop();
      this.emit_signal('timeout');
    }
  }
  _internal_process(d) { if (this._cb === 1) this._tick(d); }
  _internal_physics_process(d) { if (this._cb === 0) this._tick(d); }
  _internal_notification(what) { super._internal_notification(what); if (what === NOTIFICATION.ENTER_TREE && this.autostart) { this.autostart = false; this._time_left = this.wait_time; this._sync(); } } // Godot clears autostart after entering the tree
}
Timer.signals = ['timeout'];
ClassDB.register(Timer, 'Timer', [{ name: 'wait_time', type: 'float' }, { name: 'one_shot', type: 'bool' }, { name: 'autostart', type: 'bool' }, { name: 'process_callback', type: 'int' }]);

Object.assign(_ext, {
  ease, interpolate_variant, Animation, AnimationLibrary, AnimationPlayer, TrackType, InterpolationType, UpdateMode, LoopMode, AnimationCallbackModeProcess,
  Tween, Tweener, PropertyTweener, IntervalTweener, CallbackTweener, MethodTweener, TransitionType, EaseType, TweenProcessMode, TweenPauseMode, Timer, TimerProcessCallback,
});

// §10 ────────────────────────────────────────────────────────────────────────
// IndexedDB key/value storage. All operations return Promises.
class IDBStorage {
  constructor(db_name = 'godotjs', store = 'files') { this.db_name = db_name; this.store = store; this._db = null; this._opening = null; }
  static is_available() { return typeof indexedDB !== 'undefined'; }
  open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;
    if (!IDBStorage.is_available()) return Promise.reject(new Error('IndexedDB is not available'));
    this._opening = new Promise((res, rej) => {
      const req = indexedDB.open(this.db_name, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(this.store)) req.result.createObjectStore(this.store); };
      req.onsuccess = () => { this._db = req.result; this._db.onversionchange = () => this.close(); res(this._db); };
      req.onerror = () => rej(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => rej(new Error('IndexedDB open blocked by another connection'));
    }).finally(() => { this._opening = null; });
    return this._opening;
  }
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(this.store, mode); const st = tx.objectStore(this.store); let out;
      const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }
  put(key, value) { return this._tx('readwrite', (s) => s.put(value, key)); }
  get(key) { return this._tx('readonly', (s) => s.get(key)); }
  delete(key) { return this._tx('readwrite', (s) => s.delete(key)); }
  keys() { return this._tx('readonly', (s) => s.getAllKeys()); }
  clear() { return this._tx('readwrite', (s) => s.clear()); }
  close() { if (this._db) { this._db.close(); this._db = null; } }
  static delete_database(name) { return new Promise((res, rej) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res(); }); }
}

// user:// virtual filesystem on IndexedDB (Godot's persistent user data dir equivalent).
const UserFS = {
  _store: null,
  _s() { return this._store || (this._store = new IDBStorage('godotjs-user', 'files')); },
  _key(path) { if (!String(path).startsWith('user://')) throw new Error('UserFS paths must start with user://'); return String(path); },
  async write_file(path, data) { const v = typeof data === 'string' ? { text: data } : { bytes: data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }; await this._s().put(this._key(path), v); return Err.OK; },
  async read_text(path) { const v = await this._s().get(this._key(path)); if (!v) return null; return v.text !== undefined ? v.text : new TextDecoder().decode(v.bytes); },
  async read_bytes(path) { const v = await this._s().get(this._key(path)); if (!v) return null; return v.bytes !== undefined ? new Uint8Array(v.bytes) : new TextEncoder().encode(v.text); },
  async file_exists(path) { return (await this._s().get(this._key(path))) !== undefined; },
  async remove(path) { await this._s().delete(this._key(path)); return Err.OK; },
  async list(prefix = 'user://') { return (await this._s().keys()).filter((k) => String(k).startsWith(prefix)); },
  close() { if (this._store) this._store.close(); },
};

class JSONResource extends Resource { constructor() { super(); this.data = null; } }
ClassDB.register(JSONResource, 'JSON', [{ name: 'data', type: 'Object' }]);
class TextResource extends Resource { constructor() { super(); this.text = ''; } }
ClassDB.register(TextResource, 'TextFile', [{ name: 'text', type: 'string' }]);
class BinaryResource extends Resource { constructor() { super(); this.bytes = new Uint8Array(0); } }
ClassDB.register(BinaryResource, 'BinaryFile', [{ name: 'bytes', type: 'Uint8Array' }]);

const LoadState = Object.freeze({ REQUESTED: 'requested', LOADING: 'loading', LOADED: 'loaded', FAILED: 'failed', CANCELED: 'canceled' });
// Godot's ThreadLoadStatus values for load_threaded_get_status.
const ThreadLoadStatus = Object.freeze({ THREAD_LOAD_INVALID_RESOURCE: 0, THREAD_LOAD_IN_PROGRESS: 1, THREAD_LOAD_FAILED: 2, THREAD_LOAD_LOADED: 3 });
const CacheMode = Object.freeze({ CACHE_MODE_IGNORE: 0, CACHE_MODE_REUSE: 1, CACHE_MODE_REPLACE: 2 });

class LoadRequest {
  constructor(job) { this._job = job; this._canceled = false; }
  get state() { return this._canceled ? LoadState.CANCELED : this._job.state; }
  get progress() { return this._job.progress; }
  get error() { return this._job.error; }
  get path() { return this._job.path; }
  get promise() { return this._promise; }
  cancel() { if (this._canceled || this._job.state === LoadState.LOADED || this._job.state === LoadState.FAILED) return false; this._canceled = true; this._job._release(this); return true; }
}
class _LoadJob {
  constructor(loader, path, type_hint, opts) {
    this.loader = loader; this.path = path; this.type_hint = type_hint; this.opts = opts; this.state = LoadState.REQUESTED; this.progress = 0; this.error = null;
    this.requests = new Set(); this.abort = typeof AbortController !== 'undefined' ? new AbortController() : null; this.resource = null; this.waiters = [];
  }
  _add() {
    const r = new LoadRequest(this); this.requests.add(r);
    r._promise = new Promise((res, rej) => this.waiters.push({ r, res, rej }));
    return r;
  }
  _release(r) {
    this.requests.delete(r);
    const w = this.waiters.find((x) => x.r === r); if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); const e = new Error('Load canceled: ' + this.path); e.name = 'AbortError'; w.rej(e); }
    if (!this.requests.size && (this.state === LoadState.REQUESTED || this.state === LoadState.LOADING)) {
      this.state = LoadState.CANCELED; if (this.abort) this.abort.abort(); this.loader._jobs.delete(this.path);
    }
  }
  _finish(res, err) {
    if (this.state === LoadState.CANCELED) return;
    if (err) { this.state = LoadState.FAILED; this.error = err; for (const w of this.waiters) w.rej(err); }
    else { this.state = LoadState.LOADED; this.progress = 1; this.resource = res; for (const w of this.waiters) w.res(res); }
    this.waiters = []; this.loader._jobs.delete(this.path);
  }
}

const ResourceLoader = {
  base_url: '', _cache: new Map(), _jobs: new Map(), _threaded: new Map(), _loaders: [], stats: { fetches: 0, cache_hits: 0, dedup_hits: 0, idb_hits: 0 },
  offline_cache: null, // IDBStorage used to persist fetched bytes when opts.persist is set
  _resolve_url(path) {
    if (path.startsWith('res://')) return this.base_url + path.slice(6);
    return path;
  },
  add_format_loader(loader, at_front = false) { if (at_front) this._loaders.unshift(loader); else this._loaders.push(loader); },
  _loader_for(path, type_hint) {
    const p = path.split('?')[0].toLowerCase();
    for (const l of this._loaders) if (l.recognizes(p, type_hint)) return l;
    return null;
  },
  exists(path) { return this._cache.has(path) || !!this._loader_for(path, ''); },
  has_cached(path) { const r = this._cache.get(path); return !!r && !r._freed; },
  get_cached_ref(path) { return this.has_cached(path) ? this._cache.get(path) : null; },
  evict(path) { this._cache.delete(path); },
  clear_cache(dispose = false) { if (dispose) for (const r of this._cache.values()) if (!r._freed) r.dispose(); this._cache.clear(); },
  // Async load (the browser cannot block on network I/O). Returns a LoadRequest; await request.promise.
  request(path, type_hint = '', opts = {}) {
    const cache_mode = opts.cache_mode ?? CacheMode.CACHE_MODE_REUSE;
    if (cache_mode === CacheMode.CACHE_MODE_REUSE && this.has_cached(path)) {
      this.stats.cache_hits++;
      const job = new _LoadJob(this, path, type_hint, opts); const r = job._add(); job._finish(this._cache.get(path)); return r;
    }
    let job = this._jobs.get(path);
    if (job && cache_mode !== CacheMode.CACHE_MODE_IGNORE) { this.stats.dedup_hits++; return job._add(); }
    job = new _LoadJob(this, path, type_hint, opts); const r = job._add();
    if (cache_mode !== CacheMode.CACHE_MODE_IGNORE) this._jobs.set(path, job);
    this._run(job, cache_mode);
    return r;
  },
  load(path, type_hint = '', cache_mode = CacheMode.CACHE_MODE_REUSE) { return this.request(path, type_hint, { cache_mode }).promise; },
  async _run(job, cache_mode) {
    try {
      await Promise.resolve();
      if (job.state === LoadState.CANCELED) return;
      const loader = this._loader_for(job.path, job.type_hint);
      if (!loader) throw new Error(`No loader found for resource: ${job.path}`);
      job.state = LoadState.LOADING;
      const bytes = await this._fetch_bytes(job);
      if (job.state === LoadState.CANCELED) return;
      const res = await loader.load(bytes, job.path, job);
      if (job.state === LoadState.CANCELED) { if (res && res.dispose) res.dispose(); return; }
      res.resource_path = job.path;
      if (cache_mode !== CacheMode.CACHE_MODE_IGNORE) { const old = this._cache.get(job.path); if (old && old !== res && cache_mode === CacheMode.CACHE_MODE_REPLACE) Log.verbose('ResourceLoader: replacing cached', job.path); this._cache.set(job.path, res); }
      job._finish(res, null);
    } catch (e) {
      if (job.state === LoadState.CANCELED || (e && e.name === 'AbortError')) return;
      const err = e instanceof Error ? e : new Error(String(e)); job._finish(null, err);
      Log.error(`Failed loading resource: ${job.path}:`, err.message);
    }
  },
  async _fetch_bytes(job) {
    const path = job.path;
    if (path.startsWith('user://')) { const b = await UserFS.read_bytes(path); if (!b) throw new Error('File not found: ' + path); job.progress = 1; return b; }
    const url = this._resolve_url(path);
    if (job.opts.prefer_offline && this.offline_cache) { const v = await this.offline_cache.get(url); if (v) { this.stats.idb_hits++; job.progress = 1; return new Uint8Array(v); } }
    this.stats.fetches++;
    let resp;
    try { resp = await fetch(url, { signal: job.abort ? job.abort.signal : undefined }); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      if (this.offline_cache) { const v = await this.offline_cache.get(url); if (v) { this.stats.idb_hits++; return new Uint8Array(v); } }
      throw new Error(`Network error loading ${url}: ${e.message}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${url}`);
    const total = Number(resp.headers.get('content-length')) || 0;
    let bytes;
    if (resp.body && resp.body.getReader && total) {
      const reader = resp.body.getReader(); const chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; job.progress = Math.min(0.99, got / total); }
      bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    } else bytes = new Uint8Array(await resp.arrayBuffer());
    if (job.opts.persist && this.offline_cache) await this.offline_cache.put(url, bytes.buffer.slice(0));
    return bytes;
  },
  // Godot-style polling API on top of request().
  load_threaded_request(path, type_hint = '', use_sub_threads = false, cache_mode = CacheMode.CACHE_MODE_REUSE) {
    const r = this.request(path, type_hint, { cache_mode }); r.promise.catch((e) => Log.verbose('threaded load failed', path, e.message));
    this._threaded.set(path, r); return Err.OK;
  },
  load_threaded_get_status(path, progress = null) {
    const r = this._threaded.get(path); if (!r) return ThreadLoadStatus.THREAD_LOAD_INVALID_RESOURCE;
    if (progress) progress[0] = r.progress;
    switch (r.state) { case LoadState.LOADED: return ThreadLoadStatus.THREAD_LOAD_LOADED; case LoadState.FAILED: case LoadState.CANCELED: return ThreadLoadStatus.THREAD_LOAD_FAILED; default: return ThreadLoadStatus.THREAD_LOAD_IN_PROGRESS; }
  },
  load_threaded_get(path) { const r = this._threaded.get(path); if (!r || r.state !== LoadState.LOADED) { Log.error('load_threaded_get: resource not loaded', path); return null; } this._threaded.delete(path); return r._job.resource; },
};
const _ext_of = (p) => { const m = /\.([a-z0-9]+)$/.exec(p); return m ? m[1] : ''; };
ResourceLoader.add_format_loader({ recognizes: (p, t) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(_ext_of(p)) || t === 'Texture2D', async load(bytes, path) {
  if (typeof createImageBitmap !== 'function') throw new Error('Image decoding requires createImageBitmap');
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[_ext_of(path)] || '';
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  try { return ImageTexture.create_from_image(Image.from_source(bmp)); } finally { if (bmp.close) bmp.close(); }
} });
ResourceLoader.add_format_loader({ recognizes: (p, t) => p.endsWith('.scn.json') || t === 'PackedScene', async load(bytes) { return PackedScene.from_data(JSON.parse(new TextDecoder().decode(bytes))); } });
ResourceLoader.add_format_loader({ recognizes: (p, t) => _ext_of(p) === 'json' || t === 'JSON', async load(bytes) { const r = new JSONResource(); r.data = JSON.parse(new TextDecoder().decode(bytes)); return r; } });
ResourceLoader.add_format_loader({ recognizes: (p, t) => ['txt', 'csv', 'md', 'glsl'].includes(_ext_of(p)) || t === 'TextFile', async load(bytes) { const r = new TextResource(); r.text = new TextDecoder().decode(bytes); return r; } });
ResourceLoader.add_format_loader({ recognizes: (p, t) => ['bin', 'dat'].includes(_ext_of(p)) || t === 'BinaryFile', async load(bytes) { const r = new BinaryResource(); r.bytes = bytes; return r; } });
PackedScene.external_resource_resolver = (path) => ResourceLoader.get_cached_ref(path);

Object.assign(_ext, { IDBStorage, UserFS, ResourceLoader, LoadRequest, LoadState, ThreadLoadStatus, CacheMode, JSONResource, TextResource, BinaryResource });

// §11 ────────────────────────────────────────────────────────────────────────
const linear_to_db = (l) => (l > 0 ? Math.log(l) * 8.6858896380650365530225783783321 : -Infinity);
const db_to_linear = (db) => Math.exp(db * 0.11512925464970228420089957273422);
MathUtil.linear_to_db = linear_to_db; MathUtil.db_to_linear = db_to_linear;

const AudioServer = {
  ctx: null, _buses: [], _unlock_listeners: null, _owns_ctx: false, _signals: null, playback_speed_scale: 1, stats: { voices: 0, voices_started: 0, nodes: 0 },
  get signals() { return this._signals; },
  // Lazily creates an AudioContext (or uses one supplied, e.g. OfflineAudioContext for tests/rendering).
  init(opts = {}) {
    if (this.ctx) return this.ctx;
    if (opts.context) { this.ctx = opts.context; this._owns_ctx = false; }
    else {
      const AC = global.AudioContext || global.webkitAudioContext; if (!AC) throw new Error('Web Audio is not available');
      this.ctx = new AC({ latencyHint: opts.latency_hint || 'interactive' }); this._owns_ctx = true;
    }
    this._buses = []; this._create_bus('Master');
    this._rebuild_routing();
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed' && !(this.ctx instanceof (global.OfflineAudioContext || function () {}))) this._install_unlock();
    if (this.ctx.addEventListener) this.ctx.addEventListener('statechange', this._onstate = () => { if (this.ctx && this.ctx.state === 'running' && this._signals) this._signals.emit_signal('unlocked'); });
    return this.ctx;
  },
  is_unlocked() { return !!this.ctx && this.ctx.state === 'running'; },
  // Browsers keep an AudioContext suspended until a user gesture; resume on the first one.
  _install_unlock() {
    if (this._unlock_listeners || typeof global.addEventListener !== 'function') return;
    const fn = () => { if (!this.ctx) return; this.ctx.resume().then(() => { if (this.ctx && this.ctx.state === 'running') this._remove_unlock(); }, (e) => Log.warn('AudioContext resume failed', e.message)); };
    const types = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    for (const t of types) global.addEventListener(t, fn, { capture: true });
    this._unlock_listeners = { fn, types };
  },
  _remove_unlock() { if (!this._unlock_listeners) return; for (const t of this._unlock_listeners.types) global.removeEventListener(t, this._unlock_listeners.fn, { capture: true }); this._unlock_listeners = null; },
  unlock() { this.init(); return this.ctx.resume ? this.ctx.resume() : Promise.resolve(); },
  _create_bus(name) {
    const c = this.ctx; const b = { name, volume_db: 0, mute: false, send: 'Master', input: c.createGain(), gain: c.createGain(), mute_node: c.createGain(), solo: false, bypass: false };
    b.input.connect(b.gain); b.gain.connect(b.mute_node); this.stats.nodes += 3;
    this._buses.push(b); return b;
  },
  _rebuild_routing() {
    for (const b of this._buses) { try { b.mute_node.disconnect(); } catch (e) { Log.verbose('bus disconnect', e.message); } }
    const anySolo = this._buses.some((b) => b.solo);
    this._buses.forEach((b, i) => {
      const target = i === 0 ? this.ctx.destination : (this._bus(b.send) || this._buses[0]).input;
      b.mute_node.connect(target);
      b.gain.gain.value = db_to_linear(b.volume_db);
      b.mute_node.gain.value = b.mute || (anySolo && i > 0 && !b.solo) ? 0 : 1;
    });
  },
  _bus(name) { return this._buses.find((b) => b.name === name) || null; },
  get bus_count() { return this._buses.length; },
  add_bus(at = -1) { this.init(); const b = this._create_bus('New Bus' + (this._buses.length > 1 ? ' ' + this._buses.length : '')); if (at >= 1 && at < this._buses.length - 1) { this._buses.pop(); this._buses.splice(at, 0, b); } this._rebuild_routing(); },
  remove_bus(i) { if (i <= 0) { Log.error('Cannot remove Master bus'); return; } const b = this._buses[i]; if (!b) return; for (const n of [b.input, b.gain, b.mute_node]) n.disconnect(); this.stats.nodes -= 3; this._buses.splice(i, 1); this._rebuild_routing(); },
  get_bus_index(name) { return this._buses.findIndex((b) => b.name === name); },
  get_bus_name(i) { return this._buses[i] ? this._buses[i].name : ''; },
  set_bus_name(i, n) { this._buses[i].name = n; },
  set_bus_volume_db(i, db) { const b = this._buses[i]; b.volume_db = db; b.gain.gain.setValueAtTime(db_to_linear(db), this.ctx.currentTime); },
  get_bus_volume_db(i) { return this._buses[i].volume_db; },
  set_bus_volume_linear(i, l) { this.set_bus_volume_db(i, linear_to_db(l)); },
  set_bus_mute(i, m) { this._buses[i].mute = !!m; this._rebuild_routing(); },
  is_bus_mute(i) { return this._buses[i].mute; },
  set_bus_solo(i, s) { this._buses[i].solo = !!s; this._rebuild_routing(); },
  set_bus_send(i, send) { if (i === 0) { Log.error('Master bus has no send'); return; } this._buses[i].send = send; this._rebuild_routing(); },
  get_bus_send(i) { return this._buses[i].send; },
  _bus_input(name) { this.init(); const b = this._bus(name) || this._buses[0]; return b.input; },
  get_mix_rate() { this.init(); return this.ctx.sampleRate; },
  get_time_since_last_mix() { return 0; },
  async dispose() {
    for (const b of this._buses) for (const n of [b.input, b.gain, b.mute_node]) n.disconnect();
    this.stats.nodes = 0; this._buses = []; this._remove_unlock();
    const c = this.ctx; this.ctx = null; if (c && this._owns_ctx && c.close && c.state !== 'closed') await c.close();
  },
};
class _AudioSignals extends GObject {} _AudioSignals.signals = ['unlocked', 'bus_layout_changed'];
AudioServer._signals = new _AudioSignals();

class AudioStream extends Resource {
  get_length() { return 0; }
  _buffer(ctx) { throw new Error('AudioStream._buffer must be implemented'); }
}
ClassDB.register(AudioStream, 'AudioStream', [], { abstract: true });
// PCM sample data (Godot AudioStreamWAV semantics: 8/16-bit data, mix_rate, stereo, loop points in samples).
class AudioStreamWAV extends AudioStream {
  constructor() { super(); this.data = new Uint8Array(0); this.format = 1; this.mix_rate = 44100; this.stereo = false; this.loop_mode = 0; this.loop_begin = 0; this.loop_end = 0; this._cache = new WeakMap(); this._version = 0; this._float = null; }
  static from_float32(channels, mix_rate = 44100) {
    const s = new AudioStreamWAV(); s.mix_rate = mix_rate; s.stereo = channels.length > 1; s._float = channels.map((c) => new Float32Array(c));
    const n = channels[0].length, ch = channels.length; const d = new Int16Array(n * ch);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) d[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767)));
    s.data = new Uint8Array(d.buffer); return s;
  }
  // Minimal RIFF/WAVE PCM parser (8/16-bit integer, mono/stereo).
  static from_wav_bytes(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const str = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
    let o = 12, fmt = null, data = null;
    while (o + 8 <= dv.byteLength) { const id = str(o), sz = dv.getUint32(o + 4, true); if (id === 'fmt ') fmt = { tag: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) }; else if (id === 'data') data = bytes.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz & 1); }
    if (!fmt || !data) throw new Error('WAV missing fmt/data chunk'); if (fmt.tag !== 1) throw new Error('Only PCM WAV is supported (format tag ' + fmt.tag + ')');
    if (fmt.bits !== 8 && fmt.bits !== 16) throw new Error('Only 8/16-bit WAV is supported'); if (fmt.ch > 2) throw new Error('Only mono/stereo WAV is supported');
    const s = new AudioStreamWAV(); s.mix_rate = fmt.rate; s.stereo = fmt.ch === 2; s.format = fmt.bits === 8 ? 0 : 1;
    if (fmt.bits === 8) { const d = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) d[i] = (data[i] - 128) & 255; s.data = d; } else s.data = new Uint8Array(data);
    return s;
  }
  get_length() { const ch = this.stereo ? 2 : 1, bps = this.format === 0 ? 1 : 2; return this.data.length / (ch * bps) / this.mix_rate; }
  _buffer(ctx) {
    let b = this._cache.get(ctx); if (b && b._v === this._version) return b;
    const ch = this.stereo ? 2 : 1; const bps = this.format === 0 ? 1 : 2; const n = Math.floor(this.data.length / (ch * bps));
    b = ctx.createBuffer(ch, Math.max(1, n), this.mix_rate);
    const dv = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    for (let c = 0; c < ch; c++) {
      const out = b.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] = bps === 1 ? dv.getInt8(i * ch + c) / 128 : dv.getInt16((i * ch + c) * 2, true) / 32768;
    }
    b._v = this._version; this._cache.set(ctx, b); return b;
  }
}
AudioStreamWAV.LOOP_DISABLED = 0; AudioStreamWAV.LOOP_FORWARD = 1;
ClassDB.register(AudioStreamWAV, 'AudioStreamWAV', [{ name: 'data', type: 'Uint8Array' }, { name: 'format', type: 'int' }, { name: 'mix_rate', type: 'int' }, { name: 'stereo', type: 'bool' }, { name: 'loop_mode', type: 'int' }, { name: 'loop_begin', type: 'int' }, { name: 'loop_end', type: 'int' }]);
// Compressed audio decoded by the browser (Ogg/MP3/AAC/... as supported by decodeAudioData).
class AudioStreamDecoded extends AudioStream {
  constructor() { super(); this.loop = false; this.loop_offset = 0; this._audio_buffer = null; }
  get_length() { return this._audio_buffer ? this._audio_buffer.duration : 0; }
  _buffer() { if (!this._audio_buffer) throw new Error('AudioStreamDecoded has no decoded data'); return this._audio_buffer; }
  dispose() { this._audio_buffer = null; super.dispose(); }
}
ClassDB.register(AudioStreamDecoded, 'AudioStreamDecoded', [{ name: 'loop', type: 'bool' }, { name: 'loop_offset', type: 'float' }]);
ResourceLoader.add_format_loader({ recognizes: (p) => _ext_of(p) === 'wav', async load(bytes) { return AudioStreamWAV.from_wav_bytes(bytes); } });
ResourceLoader.add_format_loader({ recognizes: (p, t) => ['ogg', 'mp3', 'm4a', 'aac', 'flac', 'opus', 'webm'].includes(_ext_of(p)) || t === 'AudioStream', async load(bytes) {
  const ctx = AudioServer.init(); const s = new AudioStreamDecoded();
  s._audio_buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); return s;
} });

// One active voice: BufferSource -> gain(volume) [-> panner] -> bus input.
class _Voice {
  constructor(player, stream, from) {
    const ctx = AudioServer.init(); this.ctx = ctx; this.player = player;
    this.src = ctx.createBufferSource(); this.src.buffer = stream._buffer(ctx);
    this.gain = ctx.createGain(); this.src.connect(this.gain); let last = this.gain; AudioServer.stats.nodes += 2;
    if (player._spatial) { this.pan = ctx.createStereoPanner(); last.connect(this.pan); last = this.pan; AudioServer.stats.nodes++; }
    last.connect(AudioServer._bus_input(player.bus));
    if (stream instanceof AudioStreamWAV && stream.loop_mode === 1) { this.src.loop = true; this.src.loopStart = stream.loop_begin / stream.mix_rate; this.src.loopEnd = (stream.loop_end || Math.floor(stream.get_length() * stream.mix_rate)) / stream.mix_rate; }
    else if (stream instanceof AudioStreamDecoded && stream.loop) { this.src.loop = true; this.src.loopStart = stream.loop_offset; this.src.loopEnd = stream.get_length(); }
    this.src.playbackRate.value = player.pitch_scale * AudioServer.playback_speed_scale;
    this.start_ctx_time = ctx.currentTime; this.offset = from; this.duration = this.src.buffer.duration; this.loop = this.src.loop; this.alive = true;
    this.src.onended = () => this._ended();
    this.src.start(ctx.currentTime, Math.min(from, this.duration));
    AudioServer.stats.voices++; AudioServer.stats.voices_started++;
  }
  position() { const t = (this.ctx.currentTime - this.start_ctx_time) * this.src.playbackRate.value + this.offset; return this.loop ? (t >= this.src.loopEnd ? this.src.loopStart + MathUtil.fposmod(t - this.src.loopStart, this.src.loopEnd - this.src.loopStart) : t) : Math.min(t, this.duration); }
  _ended() { if (!this.alive) return; this.release(); if (this.player && !this.player._freed) this.player._voice_ended(this); }
  stop() { if (!this.alive) return; this.src.onended = null; try { this.src.stop(); } catch (e) { Log.verbose('source already stopped', e.message); } this.release(); }
  release() {
    if (!this.alive) return; this.alive = false; AudioServer.stats.voices--;
    this.src.disconnect(); this.gain.disconnect(); AudioServer.stats.nodes -= 2; if (this.pan) { this.pan.disconnect(); AudioServer.stats.nodes--; }
  }
}

class AudioStreamPlayer extends Node {
  constructor(name) { super(name); this.stream = null; this._volume_db = 0; this.pitch_scale = 1; this.bus = 'Master'; this.autoplay = false; this.max_polyphony = 1; this._voices = []; this._spatial = false; this.stream_paused = false; }
  get volume_db() { return this._volume_db; } set volume_db(v) { this._volume_db = v; this._apply_gain(); }
  get volume_linear() { return db_to_linear(this._volume_db); } set volume_linear(l) { this.volume_db = linear_to_db(l); }
  get playing() { return this._voices.length > 0; } set playing(p) { if (p) this.play(); else this.stop(); }
  is_playing() { return this._voices.length > 0; }
  _gain_linear() { return db_to_linear(this._volume_db); }
  _apply_gain() { const g = this._gain_linear(); for (const v of this._voices) v.gain.gain.setValueAtTime(g, v.ctx.currentTime); }
  play(from_position = 0) {
    if (!this.stream) { Log.error('AudioStreamPlayer.play: no stream'); return; }
    if (!this._tree) { Log.error('AudioStreamPlayer.play: node must be inside the tree'); return; }
    while (this._voices.length >= Math.max(1, this.max_polyphony)) this._voices.shift().stop();
    const v = new _Voice(this, this.stream, from_position); this._voices.push(v); this._apply_gain(); this._update_spatial && this._update_spatial();
  }
  stop() { for (const v of this._voices) v.stop(); this._voices = []; }
  seek(t) { if (this._voices.length) this.play(t); }
  get_playback_position() { const v = this._voices[this._voices.length - 1]; return v ? v.position() : 0; }
  has_stream_playback() { return this._voices.length > 0; }
  _voice_ended(v) { const i = this._voices.indexOf(v); if (i >= 0) this._voices.splice(i, 1); if (!this._voices.length) this.emit_signal('finished'); }
  _internal_notification(what) {
    super._internal_notification(what);
    if (what === NOTIFICATION.READY && this.autoplay && this.stream) this.play();
    if (what === NOTIFICATION.EXIT_TREE || what === NOTIFICATION_PREDELETE) this.stop();
  }
}
AudioStreamPlayer.signals = ['finished'];
ClassDB.register(AudioStreamPlayer, 'AudioStreamPlayer', [{ name: 'stream', type: 'Resource' }, { name: 'volume_db', type: 'float' }, { name: 'pitch_scale', type: 'float' }, { name: 'bus', type: 'string' }, { name: 'autoplay', type: 'bool' }, { name: 'max_polyphony', type: 'int' }]);

const AttenuationModel = Object.freeze({ ATTENUATION_INVERSE_DISTANCE: 0, ATTENUATION_INVERSE_SQUARE_DISTANCE: 1, ATTENUATION_LOGARITHMIC: 2, ATTENUATION_DISABLED: 3 });
// 3D voice: distance attenuation with Godot's curves (unit_size, max_db, max_distance) + stereo panning from the listener.
class AudioStreamPlayer3D extends Node3D {
  constructor(name) {
    super(name); this.stream = null; this._volume_db = 0; this.pitch_scale = 1; this.bus = 'Master'; this.autoplay = false; this.max_polyphony = 1; this._voices = []; this._spatial = true;
    this.unit_size = 10; this.max_db = 3; this.max_distance = 0; this.attenuation_model = AttenuationModel.ATTENUATION_INVERSE_DISTANCE; this.panning_strength = 1;
  }
  get volume_db() { return this._volume_db; } set volume_db(v) { this._volume_db = v; this._update_spatial(); }
  get playing() { return this._voices.length > 0; }
  is_playing() { return this._voices.length > 0; }
  _listener() { const vp = this.get_viewport(); return vp && vp._camera_3d ? vp._camera_3d._global_ref() : null; }
  get_attenuation_db(dist) {
    const u = this.unit_size; let att;
    switch (this.attenuation_model) {
      case 0: att = linear_to_db(1 / (dist / u + CMP_EPSILON)); break;
      case 1: { const d = dist / u; att = linear_to_db(1 / (d * d + CMP_EPSILON)); break; }
      case 2: att = -20 * Math.log(dist / u + CMP_EPSILON); break;
      default: att = 0;
    }
    att += this._volume_db; if (att > this.max_db) att = this.max_db;
    return att;
  }
  // Current {gain (linear), pan [-1,1]} as heard by the listener (active Camera3D).
  compute_spatial() {
    const L = this._listener(); const p = this._global_ref().origin;
    let gainDb = this._volume_db, pan = 0;
    if (L) {
      const rel = p.sub(L.origin); const dist = rel.length();
      gainDb = this.get_attenuation_db(dist);
      if (this.max_distance > 0 && dist > this.max_distance) gainDb = -Infinity;
      if (dist > 1e-6) pan = MathUtil.clamp(L.basis.x.normalized().dot(rel.div(dist)) * this.panning_strength, -1, 1);
    }
    return { gain: gainDb === -Infinity ? 0 : db_to_linear(gainDb), pan };
  }
  _update_spatial() {
    if (!this._voices.length) return;
    const { gain: g, pan } = this.compute_spatial();
    for (const v of this._voices) { v.gain.gain.setValueAtTime(g, v.ctx.currentTime); if (v.pan) v.pan.pan.setValueAtTime(pan, v.ctx.currentTime); }
    this._last_gain = g; this._last_pan = pan;
  }
  _internal_process() { this._update_spatial(); }
  _voice_ended(v) { AudioStreamPlayer.prototype._voice_ended.call(this, v); if (!this._voices.length) this.set_process_internal(false); }
  play(from = 0) { AudioStreamPlayer.prototype.play.call(this, from); this.set_process_internal(true); this._update_spatial(); }
  stop() { AudioStreamPlayer.prototype.stop.call(this); this.set_process_internal(false); }
  _gain_linear() { return this._last_gain ?? db_to_linear(this._volume_db); }
  _apply_gain() { this._update_spatial(); }
  get_playback_position() { return AudioStreamPlayer.prototype.get_playback_position.call(this); }
  _internal_notification(what) { AudioStreamPlayer.prototype._internal_notification.call(this, what); }
}
AudioStreamPlayer3D.signals = ['finished'];
ClassDB.register(AudioStreamPlayer3D, 'AudioStreamPlayer3D', [{ name: 'stream', type: 'Resource' }, { name: 'volume_db', type: 'float' }, { name: 'unit_size', type: 'float' }, { name: 'max_db', type: 'float' }, { name: 'max_distance', type: 'float' }, { name: 'attenuation_model', type: 'int' }, { name: 'bus', type: 'string' }, { name: 'autoplay', type: 'bool' }]);

Object.assign(_ext, { AudioServer, AudioStream, AudioStreamWAV, AudioStreamDecoded, AudioStreamPlayer, AudioStreamPlayer3D, AttenuationModel, linear_to_db, db_to_linear });

// §12 ────────────────────────────────────────────────────────────────────────
// WebGPU backend: 3D meshes (unlit + PBR-style lighting with directional/omni/spot lights), automatic instancing,
// frustum culling, transparency. No shadow maps and no 2D canvas rendering on this path (see report).
const WGSL_MESH = `
struct Frame { view_proj: mat4x4<f32>, cam_pos: vec4<f32>, ambient: vec4<f32>, counts: vec4<f32>,
  lpos: array<vec4<f32>, 8>, ldir: array<vec4<f32>, 8>, lcolor: array<vec4<f32>, 8>, lparams: array<vec4<f32>, 8> };
struct Mat { albedo: vec4<f32>, params: vec4<f32>, emission: vec4<f32> };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> mat: Mat;
struct VIn { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>,
  @location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>, @location(7) icol: vec4<f32> };
struct VOut { @builtin(position) clip: vec4<f32>, @location(0) world: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) col: vec4<f32> };
@vertex fn vs(v: VIn) -> VOut {
  let model = mat4x4<f32>(v.m0, v.m1, v.m2, v.m3);
  let w = model * vec4<f32>(v.pos, 1.0);
  let a = v.m0.xyz; let b = v.m1.xyz; let c = v.m2.xyz;
  // cofactor matrix = det * inverse-transpose; sign(det) keeps orientation for mirrored transforms
  let det = dot(a, cross(b, c));
  let n = (cross(b, c) * v.nrm.x + cross(c, a) * v.nrm.y + cross(a, b) * v.nrm.z) * sign(det);
  var o: VOut; o.clip = frame.view_proj * w; o.world = w.xyz; o.nrm = normalize(n); o.col = v.icol; return o;
}
fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> { return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * c, c < vec3<f32>(0.0031308)); }
fn omni_att(d: f32, inv_range: f32, decay: f32) -> f32 { var nd = d * inv_range; nd = nd * nd; nd = nd * nd; nd = max(1.0 - nd, 0.0); nd = nd * nd; return nd * pow(max(d, 0.0001), -decay); }
@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
  let albedo = mat.albedo * i.col;
  var col = albedo.rgb;
  if (mat.params.w < 0.5) {
    var N = normalize(i.nrm); if (!ff) { N = -N; }
    let V = normalize(frame.cam_pos.xyz - i.world);
    let rough = clamp(mat.params.y, 0.04, 1.0); let a = rough * rough; let a2 = a * a; let metallic = mat.params.x;
    let F0 = mix(vec3<f32>(0.16 * mat.params.z * mat.params.z), albedo.rgb, metallic);
    col = frame.ambient.rgb * albedo.rgb * (1.0 - metallic);
    let count = i32(frame.counts.x);
    for (var k = 0; k < 8; k = k + 1) {
      if (k >= count) { break; }
      let lp = frame.lpos[k]; let ty = i32(lp.w + 0.5);
      var L: vec3<f32>; var att = 1.0;
      if (ty == 0) { L = -frame.ldir[k].xyz; } else {
        let rel = lp.xyz - i.world; let d = length(rel); L = rel / max(d, 0.0001);
        att = omni_att(d, 1.0 / max(frame.lparams[k].x, 0.0001), frame.lparams[k].y);
        if (ty == 2) { let cutoff = frame.lparams[k].z; let scos = max(dot(-L, frame.ldir[k].xyz), cutoff); let rim = max(0.0001, (1.0 - scos) / (1.0 - cutoff)); att = att * (1.0 - pow(rim, frame.lparams[k].w)); }
      }
      let NdL = max(dot(N, L), 0.0);
      if (NdL <= 0.0 || att <= 0.0) { continue; }
      let H = normalize(L + V); let NdH = max(dot(N, H), 0.0); let NdV = max(dot(N, V), 0.0001); let VdH = max(dot(V, H), 0.0);
      let dd = NdH * NdH * (a2 - 1.0) + 1.0; let D = a2 / (3.14159265 * dd * dd);
      let kk = (rough + 1.0) * (rough + 1.0) / 8.0; let G = (NdV / (NdV * (1.0 - kk) + kk)) * (NdL / (NdL * (1.0 - kk) + kk));
      let F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
      let spec = D * G * F / (4.0 * NdV * NdL + 0.0001) * frame.lcolor[k].w * 2.0;
      let diff = (1.0 - F) * (1.0 - metallic) * albedo.rgb;
      col = col + (diff + spec * 3.14159265) * frame.lcolor[k].rgb * NdL * att;
    }
  }
  col = col + mat.emission.rgb;
  return vec4<f32>(linear_to_srgb(max(col, vec3<f32>(0.0))), albedo.a);
}`;
const _gpuGlobal = () => (typeof navigator !== 'undefined' ? navigator.gpu : undefined);
class WebGPUBackend {
  constructor(device, context, format, canvas) {
    this.name = 'webgpu'; this.device = device; this.context = context; this.format = format; this.canvas = canvas;
    this.gen = 1; this.lost = false; this.stats = new GPUStats(); this._owners = new Set(); this._tracked = new Set(); this.disposed = false;
    _liveBackends.add(this);
  }
  create_buffer(usage, data, size) {
    const sz = Math.max(4, Math.ceil((size || data.byteLength) / 4) * 4);
    const b = this.device.createBuffer({ size: sz, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: !!data });
    if (data) { const Ctor = data.constructor; new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); b.unmap(); }
    const w = { type: 'buffer', h: b, bytes: sz, gen: this.gen, alive: true }; this._tracked.add(w); this.stats.counts.buffer++; this.stats.bytes.buffer += sz; return w;
  }
  create_texture(desc) { const t = this.device.createTexture(desc); const bytes = desc.size[0] * desc.size[1] * 4; const w = { type: 'texture', h: t, bytes, gen: this.gen, alive: true }; this._tracked.add(w); this.stats.counts.texture++; this.stats.bytes.texture += bytes; return w; }
  _destroy(w) { if (!w || !w.alive) return; w.alive = false; this._tracked.delete(w); this.stats.counts[w.type]--; this.stats.bytes[w.type] -= w.bytes; w.h.destroy(); }
  release_entry(e) { for (const k of Object.keys(e)) { const w = e[k]; if (w && w.type && w.h) this._destroy(w); } if (e.surfaces) for (const s of e.surfaces) this.release_entry(s); }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const r of [...this._owners]) GPUCache.release(r, this);
    for (const w of [...this._tracked]) this._destroy(w);
    _liveBackends.delete(this); if (this.context && this.context.unconfigure) this.context.unconfigure(); this.device.destroy();
  }
}
class WebGPURenderer {
  static async create(canvas, opts = {}, display = null) {
    const gpu = opts._force_no_webgpu ? undefined : _gpuGlobal();
    if (!gpu) throw new Error('navigator.gpu is not available');
    const adapter = await gpu.requestAdapter(opts.power_preference ? { powerPreference: opts.power_preference } : undefined);
    if (!adapter) throw new Error('requestAdapter() returned null (no WebGPU adapter)');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu'); if (display) display._canvas_tainted = true;
    if (!context) { device.destroy(); throw new Error('canvas.getContext("webgpu") failed'); }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const b = new WebGPUBackend(device, context, format, canvas);
    const r = new WebGPURenderer(b); r.adapter = adapter; r.adapter_info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, fallback: !!adapter.info.isFallbackAdapter } : {};
    device.lost.then((info) => { if (b.disposed) return; b.lost = true; Log.error('WebGPU device lost:', info.message || info.reason); });
    device.addEventListener('uncapturederror', (e) => Log.error('WebGPU error:', e.error.message));
    return r;
  }
  constructor(backend) {
    this.backend = backend; const d = backend.device; this.device = d;
    this.module = d.createShaderModule({ code: WGSL_MESH, label: 'mesh' });
    this.frame_buf = backend.create_buffer(GPUBufferUsage.UNIFORM, null, 640);
    this.frame_layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.mat_layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    this.layout = d.createPipelineLayout({ bindGroupLayouts: [this.frame_layout, this.mat_layout] });
    this.frame_bg = d.createBindGroup({ layout: this.frame_layout, entries: [{ binding: 0, resource: { buffer: this.frame_buf.h } }] });
    this._pipelines = new Map(); this._mat_cap = 0; this._inst_cap = 0; this._depth = null; this._frame_data = new Float32Array(160);
    this._ensure_mat(64); this._ensure_inst(256 * INSTANCE_FLOATS * 4); this._warned2d = false;
    this._shader_check = this.module.getCompilationInfo ? this.module.getCompilationInfo().then((ci) => { for (const m of ci.messages) if (m.type === 'error') Log.error(`WGSL error ${m.lineNum}:${m.linePos}: ${m.message}`); }) : Promise.resolve();
  }
  _ensure_mat(n) {
    if (n <= this._mat_cap) return; let cap = Math.max(64, this._mat_cap * 2); while (cap < n) cap *= 2;
    if (this.mat_buf) this.backend._destroy(this.mat_buf);
    this.mat_buf = this.backend.create_buffer(GPUBufferUsage.UNIFORM, null, cap * 256); this._mat_cap = cap; this._mat_data = new Float32Array(cap * 64);
    this.mat_bg = this.device.createBindGroup({ layout: this.mat_layout, entries: [{ binding: 0, resource: { buffer: this.mat_buf.h, size: 48 } }] });
  }
  _ensure_inst(bytes) {
    if (bytes <= this._inst_cap) return; let cap = Math.max(4096, this._inst_cap * 2); while (cap < bytes) cap *= 2;
    if (this.inst_buf) this.backend._destroy(this.inst_buf); this.inst_buf = this.backend.create_buffer(GPUBufferUsage.VERTEX, null, cap); this._inst_cap = cap; this._inst_data = new Float32Array(cap / 4);
  }
  _pipeline(cull, transparent) {
    const key = cull + ':' + transparent; let p = this._pipelines.get(key); if (p) return p;
    const vb = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
      { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
      { arrayStride: INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map((i) => ({ shaderLocation: 3 + i, offset: i * 16, format: 'float32x4' })).concat([{ shaderLocation: 7, offset: 64, format: 'float32x4' }]) },
    ];
    p = this.device.createRenderPipeline({
      layout: this.layout, vertex: { module: this.module, entryPoint: 'vs', buffers: vb },
      fragment: { module: this.module, entryPoint: 'fs', targets: [{ format: this.backend.format, blend: transparent ? { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } : undefined }] },
      primitive: { topology: 'triangle-list', cullMode: cull === CullMode.CULL_DISABLED ? 'none' : cull === CullMode.CULL_FRONT ? 'front' : 'back', frontFace: 'ccw' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: !transparent, depthCompare: 'less-equal' },
    });
    this.backend.stats.counts.pipeline++; this._pipelines.set(key, p); return p;
  }
  _mesh_entry(mesh) {
    const b = this.backend; let e = GPUCache.get(mesh, b); if (e && e.version === mesh._version) return e; if (e) GPUCache.release(mesh, b);
    const surfaces = [];
    for (const s of mesh._surfaces_ref()) {
      const a = s.arrays; const nv = a.vertex.length / 3; const se = {};
      se.pos = b.create_buffer(GPUBufferUsage.VERTEX, a.vertex);
      se.nrm = b.create_buffer(GPUBufferUsage.VERTEX, a.normal || new Float32Array(nv * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)));
      se.uv = b.create_buffer(GPUBufferUsage.VERTEX, a.tex_uv || new Float32Array(nv * 2));
      if (a.index) { let idx = a.index; if (idx instanceof Uint16Array && idx.length % 2) { idx = new Uint16Array(idx.length + 1); idx.set(a.index); } se.index = b.create_buffer(GPUBufferUsage.INDEX, idx); se.index_format = a.index instanceof Uint32Array ? 'uint32' : 'uint16'; se.count = a.index.length; }
      else se.count = nv;
      if (s.primitive !== PrimitiveType.PRIMITIVE_TRIANGLES) Log.warn('WebGPU backend renders only triangle-list surfaces');
      surfaces.push(se);
    }
    return GPUCache.set(mesh, b, { surfaces, version: mesh._version });
  }
  _depth_for(w, h) {
    if (this._depth && this._depth.w === w && this._depth.h === h) return this._depth.view;
    if (this._depth) this.backend._destroy(this._depth.tex);
    const tex = this.backend.create_texture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this._depth = { tex, w, h, view: tex.h.createView() }; return this._depth.view;
  }
  render(vp, tree, capture = null) {
    const b = this.backend; if (b.lost || b.disposed) return false;
    b.stats.reset_frame();
    const w = this.backend.canvas.width, h = this.backend.canvas.height; vp._size.set(w, h);
    const rl = extract_render_list(vp, w / Math.max(1, h), b.stats);
    if (!this._warned2d) { tree._ensure_order(); if (tree._order.some((n) => n instanceof CanvasItem && n._visible)) { Log.warn('WebGPU backend: CanvasItem (2D/UI) rendering is not implemented; use the WebGL2 backend for 2D'); this._warned2d = true; } }
    const dev = this.device; const tex = b.context.getCurrentTexture(); const view = tex.createView();
    const enc = dev.createCommandEncoder();
    const clear = rl.clear;
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: clear.r, g: clear.g, b: clear.b, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this._depth_for(w, h), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    if (rl.camera) this._draw_3d(pass, rl);
    pass.end();
    if (capture) {
      const bpr = Math.ceil(w * 4 / 256) * 256; const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]); capture.buf = buf; capture.bpr = bpr; capture.w = w; capture.h = h;
    }
    dev.queue.submit([enc.finish()]);
    return true;
  }
  _draw_3d(pass, rl) {
    const F = this._frame_data; F.set(rl.view_proj, 0); F[16] = rl.cam_pos.x; F[17] = rl.cam_pos.y; F[18] = rl.cam_pos.z;
    const amb = rl.env ? rl.env.ambient_light_color.srgb_to_linear().mul(rl.env.ambient_light_energy) : new Color(0, 0, 0); F[20] = amb.r; F[21] = amb.g; F[22] = amb.b;
    let lc = 0;
    for (const l of rl.lights) {
      if (lc >= 8) break; const g = l._global_ref(); const o = lc * 4; const lin = l.light_color.srgb_to_linear(); const type = l instanceof DirectionalLight3D ? 0 : l instanceof SpotLight3D ? 2 : 1;
      const d = g.basis.xform(Vector3.FORWARD).normalized();
      F.set([g.origin.x, g.origin.y, g.origin.z, type], 28 + o); F.set([d.x, d.y, d.z, 0], 60 + o); F.set([lin.r * l.light_energy, lin.g * l.light_energy, lin.b * l.light_energy, l.light_specular], 92 + o);
      if (type === 1) F.set([l.omni_range, l.omni_attenuation, 0, 0], 124 + o); else if (type === 2) F.set([l.spot_range, l.spot_attenuation, Math.cos(MathUtil.deg_to_rad(l.spot_angle)), l.spot_angle_attenuation], 124 + o); else F.set([0, 0, 0, 0], 124 + o);
      lc++;
    }
    F[24] = lc;
    this.device.queue.writeBuffer(this.frame_buf.h, 0, F);
    // batches: (surface, material) -> instance lists, same grouping as GL path
    const groups = new Map(); const order = [];
    for (const inst of rl.items) {
      const isMM = inst instanceof MultiMeshInstance3D; const mesh = isMM ? inst.multimesh.mesh : inst.mesh; const e = this._mesh_entry(mesh);
      e.surfaces.forEach((se, i) => {
        const mat = isMM ? (inst.material_override || mesh.surface_get_material(i)) : inst.get_active_material(i);
        if (isMM) { order.push({ se, mat, mm: inst.multimesh, inst }); return; }
        let m = groups.get(se); if (!m) groups.set(se, (m = new Map())); let g = m.get(mat); if (!g) { g = { se, mat, list: [] }; m.set(mat, g); order.push(g); } g.list.push(inst);
      });
    }
    const opaque = order.filter((g) => !(g.mat && g.mat.transparency === Transparency.TRANSPARENCY_ALPHA)), trans = order.filter((g) => g.mat && g.mat.transparency === Transparency.TRANSPARENCY_ALPHA);
    trans.sort((a, b) => (b.list ? b.list[0] : b.inst).get_world_aabb().get_center().distance_squared_to(rl.cam_pos) - (a.list ? a.list[0] : a.inst).get_world_aabb().get_center().distance_squared_to(rl.cam_pos));
    const all = opaque.concat(trans);
    this._ensure_mat(all.length + 1);
    let instTotal = 0; for (const g of all) instTotal += g.list ? g.list.length : (g.mm.visible_instance_count < 0 ? g.mm.instance_count : Math.min(g.mm.instance_count, g.mm.visible_instance_count));
    this._ensure_inst(instTotal * INSTANCE_FLOATS * 4);
    const I = this._inst_data, M = this._mat_data; let io = 0; const tmp = new Float32Array(16); const pm = new Float32Array(16);
    all.forEach((g, gi) => {
      g.first = io;
      if (g.list) for (const inst of g.list) { Mat4.from_transform3d(inst._global_ref(), tmp); I.set(tmp, io * INSTANCE_FLOATS); const c = inst.instance_color; I.set([c.r, c.g, c.b, c.a], io * INSTANCE_FLOATS + 16); io++; }
      else { const mm = g.mm; const n = mm.visible_instance_count < 0 ? mm.instance_count : Math.min(mm.instance_count, mm.visible_instance_count); Mat4.from_transform3d(g.inst._global_ref(), pm);
        for (let i = 0; i < n; i++) { Mat4.multiply(pm, mm._xf.subarray(i * 16, i * 16 + 16), tmp); I.set(tmp, io * INSTANCE_FLOATS); if (mm.use_colors) I.set(mm._col.subarray(i * 4, i * 4 + 4), io * INSTANCE_FLOATS + 16); else I.set([1, 1, 1, 1], io * INSTANCE_FLOATS + 16); io++; } }
      g.count = io - g.first;
      const m = g.mat instanceof StandardMaterial3D ? g.mat : _defaultMaterial; const c = m.albedo_color.srgb_to_linear(); const e = m.emission_enabled ? m.emission.srgb_to_linear().mul(m.emission_energy_multiplier) : new Color(0, 0, 0);
      if (g.mat && !(g.mat instanceof StandardMaterial3D) && !this._warned_sm) { Log.warn('WebGPU backend: ShaderMaterial (GLSL) is not supported; drawing with default material'); this._warned_sm = true; }
      M.set([c.r, c.g, c.b, c.a, m.metallic, m.roughness, m.metallic_specular, m.shading_mode === ShadingMode.SHADING_MODE_UNSHADED ? 1 : 0, e.r, e.g, e.b, 0], gi * 64);
    });
    this.device.queue.writeBuffer(this.inst_buf.h, 0, I, 0, io * INSTANCE_FLOATS);
    this.device.queue.writeBuffer(this.mat_buf.h, 0, M, 0, all.length * 64);
    pass.setBindGroup(0, this.frame_bg);
    const st = this.backend.stats.frame;
    all.forEach((g, gi) => {
      if (!g.count) return;
      pass.setPipeline(this._pipeline(g.mat ? g.mat.cull_mode : 0, g.mat ? g.mat.transparency === 1 : false));
      pass.setBindGroup(1, this.mat_bg, [gi * 256]);
      pass.setVertexBuffer(0, g.se.pos.h); pass.setVertexBuffer(1, g.se.nrm.h); pass.setVertexBuffer(2, g.se.uv.h); pass.setVertexBuffer(3, this.inst_buf.h, g.first * INSTANCE_FLOATS * 4);
      if (g.se.index) { pass.setIndexBuffer(g.se.index.h, g.se.index_format); pass.drawIndexed(g.se.count, g.count); } else pass.draw(g.se.count, g.count);
      st.draw_calls++; st.primitives += g.se.count / 3 * g.count;
    });
  }
  // Renders the current tree again and returns top-left-origin RGBA8 pixels.
  async read_pixels_async(vp, tree, x = 0, y = 0, w = null, h = null) {
    const cap = {}; this.render(vp, tree, cap); await cap.buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(cap.buf.getMappedRange()); w = w ?? cap.w; h = h ?? cap.h; const out = new Uint8Array(w * h * 4);
    const bgra = this.backend.format.startsWith('bgra');
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = (y + j) * cap.bpr + (x + i) * 4, d = (j * w + i) * 4;
      out[d] = src[s + (bgra ? 2 : 0)]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + (bgra ? 0 : 2)]; out[d + 3] = src[s + 3];
    }
    cap.buf.unmap(); cap.buf.destroy(); return out;
  }
  // Buffers/textures are destroyed by the backend; pipelines have no destroy() in WebGPU and are dropped for GC.
  dispose() { this.backend.stats.counts.pipeline -= this._pipelines.size; this._pipelines.clear(); }
}
Display.prototype.read_pixels_async = function (x = 0, y = 0, w = null, h = null) {
  if (this.backend_name === 'webgpu') return this.renderer.read_pixels_async(this.tree.root, this.tree, x, y, w, h);
  return Promise.resolve(this.read_pixels(x, y, w ?? this.canvas.width, h ?? this.canvas.height));
};
Viewport.prototype.attach_canvas_async = function (canvas, opts) { if (!this._tree) throw new Error('attach_canvas_async: viewport is not in a tree'); return Display.create(this._tree, canvas, opts); };
Object.assign(_ext, { WebGPUBackend, WebGPURenderer });

// ── CPU particles (2D), simulated on the CPU, drawn through the canvas batcher.
class Gradient extends Resource {
  constructor() { super(); this.offsets = [0, 1]; this.colors = [new Color(0, 0, 0, 1), new Color(1, 1, 1, 1)]; }
  sample(t) {
    const o = this.offsets, c = this.colors; if (!o.length) return new Color(1, 1, 1, 1);
    if (t <= o[0]) return c[0].clone(); if (t >= o[o.length - 1]) return c[c.length - 1].clone();
    for (let i = 0; i < o.length - 1; i++) if (t >= o[i] && t <= o[i + 1]) return c[i].lerp(c[i + 1], (t - o[i]) / (o[i + 1] - o[i] || 1));
    return c[c.length - 1].clone();
  }
}
ClassDB.register(Gradient, 'Gradient', [{ name: 'offsets', type: 'Array' }, { name: 'colors', type: 'Array' }]);
const _mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const PF = 9; // floats per particle: x, y, vx, vy, age, life, scale, active, rotation
class CPUParticles2D extends Node2D {
  constructor(name) {
    super(name); this._emitting = true; this._amount = 8; this.lifetime = 1; this.one_shot = false; this.explosiveness = 0; this.randomness = 0; this.preprocess = 0; this.speed_scale = 1;
    this.direction = new Vector2(1, 0); this.spread = 45; this.gravity = new Vector2(0, 980); this.initial_velocity_min = 0; this.initial_velocity_max = 0;
    this.scale_amount_min = 1; this.scale_amount_max = 1; this.color = new Color(1, 1, 1, 1); this.color_ramp = null; this.texture = null; this.local_coords = false;
    this.emission_shape = 0; this.emission_sphere_radius = 1; this.emission_rect_extents = new Vector2(1, 1); this.seed = 0; this.use_fixed_seed = false;
    this._time = 0; this._cycle = 0; this._data = new Float32Array(8 * PF); this._rand = Math.random; this._finished_emitted = false; this._last_cycle_t = 0;
    this.set_process_internal(true);
  }
  get amount() { return this._amount; } set amount(n) { this._amount = Math.max(1, n | 0); this._data = new Float32Array(this._amount * PF); this.restart(); }
  get emitting() { return this._emitting; } set emitting(e) { if (e && !this._emitting && this.one_shot) this.restart(); this._emitting = !!e; if (e) this.set_process_internal(true); }
  restart() { this._data.fill(0); this._time = 0; this._cycle = 0; this._last_cycle_t = 0; this._finished_emitted = false; this._rand = this.use_fixed_seed ? _mulberry32(this.seed) : Math.random; }
  get_alive_count() { let n = 0; for (let i = 0; i < this._amount; i++) if (this._data[i * PF + 7]) n++; return n; }
  get_particle(i) { const o = i * PF, d = this._data; return { position: new Vector2(d[o], d[o + 1]), velocity: new Vector2(d[o + 2], d[o + 3]), age: d[o + 4], active: !!d[o + 7] }; }
  _emit(i) {
    const d = this._data, o = i * PF, R = this._rand;
    const base = this.direction.angle(); const ang = base + MathUtil.deg_to_rad(this.spread) * (R() * 2 - 1);
    const v = MathUtil.lerp(this.initial_velocity_min, this.initial_velocity_max, R());
    let px = 0, py = 0;
    if (this.emission_shape === 1) { const a = R() * Math.PI * 2, r = Math.sqrt(R()) * this.emission_sphere_radius; px = Math.cos(a) * r; py = Math.sin(a) * r; }
    else if (this.emission_shape === 3) { px = (R() * 2 - 1) * this.emission_rect_extents.x; py = (R() * 2 - 1) * this.emission_rect_extents.y; }
    if (!this.local_coords) { const g = this.get_global_transform(); const p = g.xform(new Vector2(px, py)); px = p.x; py = p.y; }
    d[o] = px; d[o + 1] = py; d[o + 2] = Math.cos(ang) * v; d[o + 3] = Math.sin(ang) * v; d[o + 4] = 0;
    d[o + 5] = this.lifetime * (1 - this.randomness * R()); d[o + 6] = MathUtil.lerp(this.scale_amount_min, this.scale_amount_max, R()); d[o + 7] = 1;
  }
  // Godot-style slot emission: particle i spawns at phase i/amount * lifetime * (1 - explosiveness) of each cycle.
  _internal_process(delta) {
    if (!this._tree) return; delta *= this.speed_scale; const d = this._data, n = this._amount, L = this.lifetime; const g = this.gravity;
    for (let i = 0; i < n; i++) {
      const o = i * PF; if (!d[o + 7]) continue;
      d[o + 4] += delta; if (d[o + 4] >= d[o + 5]) { d[o + 7] = 0; continue; }
      d[o + 2] += g.x * delta; d[o + 3] += g.y * delta; d[o] += d[o + 2] * delta; d[o + 1] += d[o + 3] * delta;
    }
    if (this._emitting) {
      const t0 = this._time, t1 = this._time + delta; const span = L * (1 - this.explosiveness);
      for (let i = 0; i < n; i++) {
        const phase = (i / n) * span;
        // emit for each cycle boundary crossed by (t0, t1]
        let k = Math.ceil((t0 - phase) / L - 1e-9); if (t0 === 0 && phase === 0) k = 0;
        for (let tt = phase + k * L; tt <= t1 + 1e-9; tt += L) {
          if (tt < t0 - 1e-9 || (tt === t0 && t0 !== 0)) continue;
          if (this.one_shot && tt >= L - 1e-9) break;
          this._emit(i); const o = i * PF; const age = t1 - tt; d[o + 4] = age;
          d[o + 2] += g.x * age; d[o + 3] += g.y * age; d[o] += (d[o + 2] - g.x * age * 0.5) * age; d[o + 1] += (d[o + 3] - g.y * age * 0.5) * age;
        }
      }
      this._time = t1;
      if (this.one_shot && this._time >= L) this._emitting = false;
    }
    if (!this._emitting && this.one_shot && !this._finished_emitted && this.get_alive_count() === 0) { this._finished_emitted = true; this.emit_signal('finished'); }
  }
  _draw_ui(r, xf, mod) {
    const d = this._data; const tex = this.texture ? r._texture_entry(this.texture, false) : null; const tw = this.texture ? this.texture.get_width() : 1, th = this.texture ? this.texture.get_height() : 1;
    const inv = this.local_coords ? null : this.get_global_transform().affine_inverse();
    const c = new Color();
    for (let i = 0; i < this._amount; i++) {
      const o = i * PF; if (!d[o + 7]) continue;
      let x = d[o], y = d[o + 1]; if (inv) { const p = inv.xform(new Vector2(x, y)); x = p.x; y = p.y; }
      const s = d[o + 6]; const base = this.color_ramp ? this.color_ramp.sample(d[o + 4] / d[o + 5]).mul(this.color) : this.color;
      c.set(base.r * mod.r, base.g * mod.g, base.b * mod.b, base.a * mod.a);
      r._quad(xf, x - tw * s / 2, y - th * s / 2, tw * s, th * s, 0, 0, 1, 1, c, tex);
    }
  }
}
CPUParticles2D.signals = ['finished'];
ClassDB.register(CPUParticles2D, 'CPUParticles2D', [{ name: 'emitting', type: 'bool' }, { name: 'amount', type: 'int' }, { name: 'lifetime', type: 'float' }, { name: 'one_shot', type: 'bool' }, { name: 'explosiveness', type: 'float' }, { name: 'direction', type: 'Vector2' }, { name: 'spread', type: 'float' }, { name: 'gravity', type: 'Vector2' }, { name: 'initial_velocity_min', type: 'float' }, { name: 'initial_velocity_max', type: 'float' }, { name: 'color', type: 'Color' }, { name: 'color_ramp', type: 'Resource' }, { name: 'texture', type: 'Resource' }, { name: 'seed', type: 'int' }, { name: 'use_fixed_seed', type: 'bool' }]);

// ── Serialization: explicit per-class property schema (ClassDB), resources shared by id, cycles allowed.
const Serializer = {
  FORMAT: 'godotjs-resource', VERSION: 1,
  encode_resource(res) { const ctx = new _SerializeContext(); const root = ctx.ref_resource(res, true); return { format: this.FORMAT, version: this.VERSION, root, resources: ctx.resources }; },
  decode_resource(data) {
    if (!data || data.format !== this.FORMAT) throw new Error('Serializer.decode_resource: not a godotjs resource');
    if (data.version > this.VERSION) throw new Error('Serializer: unsupported format version ' + data.version);
    return new _DeserializeContext(data.resources, PackedScene.external_resource_resolver).get_resource(data.root);
  },
  encode_scene(node) { const ps = new PackedScene(); if (ps.pack(node) !== Err.OK) throw new Error('pack failed'); const d = { format: 'godotjs-scene', version: 1, state: ps.get_state() }; ps.dispose(); return d; },
  decode_scene(data) { if (!data || data.format !== 'godotjs-scene') throw new Error('Serializer.decode_scene: not a godotjs scene'); return PackedScene.from_data(data.state); },
  to_text(data) { return JSON.stringify(data); }, // data is already schema-encoded plain values
};
// Local resources only: a resource with a resource_path is written by reference, so save() encodes the root by value.
_SerializeContext.prototype.ref_resource = (function (orig) {
  return function (r, force_inline = false) {
    if (force_inline === true) { const p = r.resource_path; r.resource_path = ''; try { return orig.call(this, r); } finally { r.resource_path = p; } }
    return orig.call(this, r);
  };
})(_SerializeContext.prototype.ref_resource);
const ResourceSaver = {
  // Returns a Promise<Error>. user:// paths persist to IndexedDB; other paths are not writable from a browser.
  async save(res, path) {
    if (!path.startsWith('user://')) { Log.error('ResourceSaver.save: only user:// paths are writable in the browser'); return Err.ERR_UNAVAILABLE; }
    const data = res instanceof PackedScene ? { format: 'godotjs-scene', version: 1, state: res.get_state() } : Serializer.encode_resource(res);
    await UserFS.write_file(path, Serializer.to_text(data)); return Err.OK;
  },
};
ResourceLoader.add_format_loader({ recognizes: (p) => p.endsWith('.res.json') || p.endsWith('.tres.json'), async load(bytes) { return Serializer.decode_resource(JSON.parse(new TextDecoder().decode(bytes))); } }, true);
ResourceLoader.add_format_loader({ recognizes: (p) => p.endsWith('.tscn.json'), async load(bytes) { return Serializer.decode_scene(JSON.parse(new TextDecoder().decode(bytes))); } }, true);

// ── Networking
const HTTPMethod = Object.freeze({ METHOD_GET: 0, METHOD_HEAD: 1, METHOD_POST: 2, METHOD_PUT: 3, METHOD_DELETE: 4, METHOD_OPTIONS: 5, METHOD_TRACE: 6, METHOD_CONNECT: 7, METHOD_PATCH: 8 });
const _methodNames = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PATCH'];
const HTTPResult = Object.freeze({ RESULT_SUCCESS: 0, RESULT_CHUNKED_BODY_SIZE_MISMATCH: 1, RESULT_CANT_CONNECT: 2, RESULT_CANT_RESOLVE: 3, RESULT_CONNECTION_ERROR: 4, RESULT_TLS_HANDSHAKE_ERROR: 5, RESULT_NO_RESPONSE: 6, RESULT_BODY_SIZE_LIMIT_EXCEEDED: 7, RESULT_BODY_DECOMPRESS_FAILED: 8, RESULT_REQUEST_FAILED: 9, RESULT_DOWNLOAD_FILE_CANT_OPEN: 10, RESULT_DOWNLOAD_FILE_WRITE_ERROR: 11, RESULT_REDIRECT_LIMIT_REACHED: 12, RESULT_TIMEOUT: 13 });
class HTTPRequest extends Node {
  constructor(name) { super(name); this.timeout = 0; this.body_size_limit = -1; this._busy = false; this._abort = null; this._timer = 0; this._status = 0; }
  request(url, custom_headers = [], method = HTTPMethod.METHOD_GET, request_data = '') {
    if (this._busy) { Log.error('HTTPRequest is processing a request. Wait for completion or cancel it before attempting a new one.'); return Err.ERR_BUSY; }
    return this._do(url, custom_headers, method, request_data);
  }
  request_raw(url, custom_headers = [], method = HTTPMethod.METHOD_GET, data = new Uint8Array(0)) { if (this._busy) return Err.ERR_BUSY; return this._do(url, custom_headers, method, data); }
  _do(url, custom_headers, method, body) {
    const headers = {}; for (const h of custom_headers) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
    this._busy = true; this._abort = new AbortController(); const ab = this._abort; let timedOut = false;
    if (this.timeout > 0) this._timer = setTimeout(() => { timedOut = true; ab.abort(); }, this.timeout * 1000);
    const m = _methodNames[method] || 'GET';
    fetch(url, { method: m, headers, body: m === 'GET' || m === 'HEAD' ? undefined : body, signal: ab.signal }).then(async (resp) => {
      const hdrs = []; resp.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`));
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (this.body_size_limit >= 0 && buf.length > this.body_size_limit) return this._done(HTTPResult.RESULT_BODY_SIZE_LIMIT_EXCEEDED, resp.status, hdrs, new Uint8Array(0));
      this._done(HTTPResult.RESULT_SUCCESS, resp.status, hdrs, buf);
    }, (e) => {
      if (e.name === 'AbortError') { if (timedOut) this._done(HTTPResult.RESULT_TIMEOUT, 0, [], new Uint8Array(0)); return; }
      this._done(HTTPResult.RESULT_CANT_CONNECT, 0, [], new Uint8Array(0));
    });
    return Err.OK;
  }
  _done(result, code, headers, body) { clearTimeout(this._timer); this._busy = false; this._abort = null; if (!this._freed) this.emit_signal('request_completed', result, code, headers, body); }
  cancel_request() { if (this._abort) { this._abort.abort(); clearTimeout(this._timer); this._busy = false; this._abort = null; } }
  get_http_client_status() { return this._busy ? 7 : 0; }
  _internal_notification(what) { super._internal_notification(what); if (what === NOTIFICATION_PREDELETE) this.cancel_request(); }
}
HTTPRequest.signals = ['request_completed'];
ClassDB.register(HTTPRequest, 'HTTPRequest', [{ name: 'timeout', type: 'float' }, { name: 'body_size_limit', type: 'int' }]);

// WebSocketPeer over the browser WebSocket; packets become available on poll(), as in Godot.
class WebSocketPeer extends GObject {
  constructor() { super(); this._ws = null; this._incoming = []; this._packets = []; this._last_string = false; this.supported_protocols = []; this._close_code = -1; this._close_reason = ''; this.inbound_buffer_size = 65535; }
  connect_to_url(url) {
    if (this._ws && this._ws.readyState < 2) { Log.error('WebSocketPeer: already connected'); return Err.ERR_ALREADY_IN_USE; }
    try { this._ws = this.supported_protocols.length ? new WebSocket(url, this.supported_protocols) : new WebSocket(url); }
    catch (e) { Log.error('WebSocketPeer.connect_to_url:', e.message); return Err.ERR_CANT_CONNECT; }
    this._ws.binaryType = 'arraybuffer'; this._close_code = -1;
    this._ws.onmessage = (ev) => { const s = typeof ev.data === 'string'; this._incoming.push({ data: s ? new TextEncoder().encode(ev.data) : new Uint8Array(ev.data), text: s }); };
    this._ws.onclose = (ev) => { this._close_code = ev.code; this._close_reason = ev.reason; };
    this._ws.onerror = () => Log.warn('WebSocketPeer: connection error', url);
    return Err.OK;
  }
  poll() { if (this._incoming.length) { this._packets.push(...this._incoming); this._incoming.length = 0; } }
  get_ready_state() { return this._ws ? this._ws.readyState : 3; }
  send_text(t) { if (this.get_ready_state() !== 1) return Err.FAILED; this._ws.send(String(t)); return Err.OK; }
  send(bytes, write_mode = 1) { if (this.get_ready_state() !== 1) return Err.FAILED; if (write_mode === 0) this._ws.send(new TextDecoder().decode(bytes)); else this._ws.send(bytes); return Err.OK; }
  put_packet(bytes) { return this.send(bytes, 1); }
  get_available_packet_count() { return this._packets.length; }
  get_packet() { const p = this._packets.shift(); if (!p) return new Uint8Array(0); this._last_string = p.text; return p.data; }
  was_string_packet() { return this._last_string; }
  close(code = 1000, reason = '') { if (this._ws && this._ws.readyState < 2) this._ws.close(code, reason); }
  get_close_code() { return this._close_code; } get_close_reason() { return this._close_reason; }
  get_requested_url() { return this._ws ? this._ws.url : ''; }
  free() { if (this._ws) { this._ws.onmessage = this._ws.onclose = this._ws.onerror = null; if (this._ws.readyState < 2) this._ws.close(); this._ws = null; } super.free(); }
}
WebSocketPeer.STATE_CONNECTING = 0; WebSocketPeer.STATE_OPEN = 1; WebSocketPeer.STATE_CLOSING = 2; WebSocketPeer.STATE_CLOSED = 3; WebSocketPeer.WRITE_MODE_TEXT = 0; WebSocketPeer.WRITE_MODE_BINARY = 1;
ClassDB.register(WebSocketPeer, 'WebSocketPeer', []);

// ── UI: Control with anchors/offsets, Label, Button, ColorRect, Panel
const LayoutPreset = Object.freeze({ PRESET_TOP_LEFT: 0, PRESET_TOP_RIGHT: 1, PRESET_BOTTOM_LEFT: 2, PRESET_BOTTOM_RIGHT: 3, PRESET_CENTER_LEFT: 4, PRESET_CENTER_TOP: 5, PRESET_CENTER_RIGHT: 6, PRESET_CENTER_BOTTOM: 7, PRESET_CENTER: 8, PRESET_LEFT_WIDE: 9, PRESET_TOP_WIDE: 10, PRESET_RIGHT_WIDE: 11, PRESET_BOTTOM_WIDE: 12, PRESET_VCENTER_WIDE: 13, PRESET_HCENTER_WIDE: 14, PRESET_FULL_RECT: 15 });
const _presetAnchors = [[0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1], [1, 1, 1, 1], [0, 0.5, 0, 0.5], [0.5, 0, 0.5, 0], [1, 0.5, 1, 0.5], [0.5, 1, 0.5, 1], [0.5, 0.5, 0.5, 0.5], [0, 0, 0, 1], [0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0.5, 1, 0.5], [0.5, 0, 0.5, 1], [0, 0, 1, 1]];
const MouseFilter = Object.freeze({ MOUSE_FILTER_STOP: 0, MOUSE_FILTER_PASS: 1, MOUSE_FILTER_IGNORE: 2 });
const HorizontalAlignment = Object.freeze({ HORIZONTAL_ALIGNMENT_LEFT: 0, HORIZONTAL_ALIGNMENT_CENTER: 1, HORIZONTAL_ALIGNMENT_RIGHT: 2 });
const VerticalAlignment = Object.freeze({ VERTICAL_ALIGNMENT_TOP: 0, VERTICAL_ALIGNMENT_CENTER: 1, VERTICAL_ALIGNMENT_BOTTOM: 2 });
class Control extends CanvasItem {
  constructor(name) {
    super(name); this.anchor_left = 0; this.anchor_top = 0; this.anchor_right = 0; this.anchor_bottom = 0;
    this.offset_left = 0; this.offset_top = 0; this.offset_right = 0; this.offset_bottom = 0; this.custom_minimum_size = new Vector2();
    this.mouse_filter = MouseFilter.MOUSE_FILTER_STOP; this._theme_colors = new Map(); this._theme_sizes = new Map(); this._hovered = false; this._lx = new Transform2D();
    this.tooltip_text = '';
  }
  _parent_rect() {
    const p = this._parent;
    if (p instanceof Control) { const s = p.size; return new Rect2(0, 0, s.x, s.y); }
    const vp = this.get_viewport(); return vp ? vp.get_visible_rect() : new Rect2(0, 0, 0, 0);
  }
  _computed() {
    const pr = this._parent_rect(); const W = pr.size.x, H = pr.size.y;
    let l = this.anchor_left * W + this.offset_left, t = this.anchor_top * H + this.offset_top, r = this.anchor_right * W + this.offset_right, b = this.anchor_bottom * H + this.offset_bottom;
    const min = this.get_combined_minimum_size(); if (r - l < min.x) r = l + min.x; if (b - t < min.y) b = t + min.y;
    return [l, t, r, b];
  }
  get position() { const [l, t] = this._computed(); return new Vector2(l, t); }
  set position(p) { const [l, t] = this._computed(); const dx = p.x - l, dy = p.y - t; this.offset_left += dx; this.offset_right += dx; this.offset_top += dy; this.offset_bottom += dy; this._gdirty = false; this._propagate_xform_dirty(); }
  get size() { const [l, t, r, b] = this._computed(); return new Vector2(r - l, b - t); }
  set size(s) { const [l, t] = this._computed(); const pr = this._parent_rect(); this.offset_right = l + s.x - this.anchor_right * pr.size.x; this.offset_bottom = t + s.y - this.anchor_bottom * pr.size.y; this._propagate_xform_dirty(); }
  get global_position() { return this.get_global_transform().origin.clone(); }
  get_rect() { const [l, t, r, b] = this._computed(); return new Rect2(l, t, r - l, b - t); }
  get_global_rect() { const g = this.get_global_transform(); const s = this.size; return new Rect2(g.origin.x, g.origin.y, s.x, s.y); }
  get_minimum_size() { return new Vector2(); }
  get_combined_minimum_size() { const m = this.get_minimum_size(); return new Vector2(Math.max(m.x, this.custom_minimum_size.x), Math.max(m.y, this.custom_minimum_size.y)); }
  // Layout is recomputed on demand, so the transform is never cached for Controls.
  get_global_transform() {
    const p = this._parent_canvas(); const [l, t] = this._computed(); this._lx.x.set(1, 0); this._lx.y.set(0, 1); this._lx.origin.set(l, t);
    if (p) Transform2D.mul_into(p.get_global_transform(), this._lx, this._gx); else this._gx.copy(this._lx);
    return this._gx;
  }
  _local_xform_ref() { const [l, t] = this._computed(); this._lx.origin.set(l, t); return this._lx; }
  set_anchor(side, v) { this['anchor_' + ['left', 'top', 'right', 'bottom'][side]] = v; }
  set_anchors_preset(preset) { const a = _presetAnchors[preset]; [this.anchor_left, this.anchor_top, this.anchor_right, this.anchor_bottom] = a; }
  // Anchors and offsets so the control sits at the preset with its minimum size (margin from edges).
  set_anchors_and_offsets_preset(preset, resize_mode = 0, margin = 0) {
    this.set_anchors_preset(preset); const m = this.get_combined_minimum_size(); const a = _presetAnchors[preset];
    const fit = (a0, a1, size) => { if (a0 !== a1) return [margin, -margin]; if (a0 === 0) return [margin, margin + size]; if (a0 === 1) return [-margin - size, -margin]; return [-size / 2, size / 2]; };
    const sz = this.size; const w = resize_mode === 0 ? Math.max(m.x, sz.x) : m.x, h = resize_mode === 0 ? Math.max(m.y, sz.y) : m.y;
    [this.offset_left, this.offset_right] = fit(a[0], a[2], w); [this.offset_top, this.offset_bottom] = fit(a[1], a[3], h);
  }
  add_theme_color_override(n, c) { this._theme_colors.set(n, c.clone()); this.queue_redraw(); }
  add_theme_font_size_override(n, s) { this._theme_sizes.set(n, s); this.queue_redraw(); }
  get_theme_color(n, def) { return this._theme_colors.get(n) || def; }
  get_theme_font_size(n, def = 16) { return this._theme_sizes.has(n) ? this._theme_sizes.get(n) : def; }
  has_point(p) { const s = this.size; return p.x >= 0 && p.y >= 0 && p.x < s.x && p.y < s.y; }
  accept_event() { const vp = this.get_viewport(); if (vp) vp.set_input_as_handled(); }
  _gui_event(ev) { if (typeof this._gui_input === 'function') this._safe_call('_gui_input', ev); this.emit_signal('gui_input', ev); }
}
Control.signals = ['gui_input', 'mouse_entered', 'mouse_exited', 'resized', 'focus_entered', 'focus_exited', 'minimum_size_changed'];
ClassDB.register(Control, 'Control', [{ name: 'anchor_left', type: 'float' }, { name: 'anchor_top', type: 'float' }, { name: 'anchor_right', type: 'float' }, { name: 'anchor_bottom', type: 'float' }, { name: 'offset_left', type: 'float' }, { name: 'offset_top', type: 'float' }, { name: 'offset_right', type: 'float' }, { name: 'offset_bottom', type: 'float' }, { name: 'custom_minimum_size', type: 'Vector2' }, { name: 'mouse_filter', type: 'int' }]);

// Text rasterized with Canvas 2D into an ImageTexture (cached per text/size/color).
const _TextRaster = {
  _canvas: null,
  _ctx() { if (!this._canvas) { this._canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas'); } return this._canvas.getContext('2d', { willReadFrequently: true }); },
  font(size) { return `${size}px sans-serif`; },
  measure(text, size) { const c = this._ctx(); c.font = this.font(size); const lines = String(text).split('\n'); let w = 0; for (const l of lines) w = Math.max(w, c.measureText(l).width); return new Vector2(Math.ceil(w), Math.ceil(size * 1.25) * lines.length); },
  render(text, size, color) {
    const m = this.measure(text, size); const w = Math.max(1, m.x), h = Math.max(1, m.y); const cv = this._canvas; cv.width = w; cv.height = h;
    const c = this._ctx(); c.clearRect(0, 0, w, h); c.font = this.font(size); c.textBaseline = 'top'; c.fillStyle = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${color.a})`;
    String(text).split('\n').forEach((l, i) => c.fillText(l, 0, i * Math.ceil(size * 1.25) + size * 0.1));
    const img = Image.create_from_data(w, h, c.getImageData(0, 0, w, h).data); const t = ImageTexture.create_from_image(img); t.filter = TextureFilter.LINEAR; return t;
  },
};
class Label extends Control {
  constructor(name) { super(name); this._text = ''; this.horizontal_alignment = 0; this.vertical_alignment = 0; this.mouse_filter = MouseFilter.MOUSE_FILTER_IGNORE; this._tex = null; this._tex_key = ''; }
  get text() { return this._text; } set text(t) { this._text = String(t); this.queue_redraw(); }
  _font_size() { return this.get_theme_font_size('font_size', 16); }
  get_minimum_size() { return this._text ? _TextRaster.measure(this._text, this._font_size()) : new Vector2(); }
  _text_texture(color) {
    const key = this._text + '|' + this._font_size() + '|' + color.to_html();
    if (key !== this._tex_key) { if (this._tex) this._tex.dispose(); this._tex = this._text ? _TextRaster.render(this._text, this._font_size(), color) : null; this._tex_key = key; }
    return this._tex;
  }
  _draw_text(r, xf, mod, color, rect) {
    const tex = this._text_texture(color); if (!tex) return; const w = tex.get_width(), h = tex.get_height();
    const x = rect.position.x + (this.horizontal_alignment === 1 ? (rect.size.x - w) / 2 : this.horizontal_alignment === 2 ? rect.size.x - w : 0);
    const y = rect.position.y + (this.vertical_alignment === 1 ? (rect.size.y - h) / 2 : this.vertical_alignment === 2 ? rect.size.y - h : 0);
    r._quad(xf, Math.round(x), Math.round(y), w, h, 0, 0, 1, 1, mod, r._texture_entry(tex, false));
  }
  _draw_ui(r, xf, mod) { this._draw_text(r, xf, mod, this.get_theme_color('font_color', new Color(1, 1, 1, 1)), new Rect2(new Vector2(), this.size)); }
  _internal_notification(what) { super._internal_notification(what); if (what === NOTIFICATION_PREDELETE && this._tex) { this._tex.dispose(); this._tex = null; } }
}
ClassDB.register(Label, 'Label', [{ name: 'text', type: 'string' }, { name: 'horizontal_alignment', type: 'int' }, { name: 'vertical_alignment', type: 'int' }]);
class ColorRect extends Control {
  constructor(name) { super(name); this.color = new Color(1, 1, 1, 1); }
  _draw_ui(r, xf, mod) { const s = this.size; r._quad(xf, 0, 0, s.x, s.y, 0, 0, 1, 1, this.color.mul(mod), null); }
}
ClassDB.register(ColorRect, 'ColorRect', [{ name: 'color', type: 'Color' }]);
class Panel extends Control {
  _draw_ui(r, xf, mod) { const s = this.size; r._quad(xf, 0, 0, s.x, s.y, 0, 0, 1, 1, this.get_theme_color('panel', new Color(0.2, 0.2, 0.25, 1)).mul(mod), null); }
}
ClassDB.register(Panel, 'Panel', []);
class Button extends Label {
  constructor(name) {
    super(name); this.mouse_filter = MouseFilter.MOUSE_FILTER_STOP; this.horizontal_alignment = 1; this.vertical_alignment = 1;
    this.disabled = false; this.toggle_mode = false; this._button_pressed = false; this._down = false; this.flat = false;
  }
  get button_pressed() { return this._button_pressed; }
  set button_pressed(v) { v = !!v; if (v === this._button_pressed) return; this._button_pressed = v; if (this.toggle_mode) this.emit_signal('toggled', v); }
  set_pressed_no_signal(v) { this._button_pressed = !!v; }
  is_hovered() { return this._hovered; }
  get_draw_mode() { if (this.disabled) return 3; if (this._down || this._button_pressed) return 1; if (this._hovered) return 2; return 0; } // DRAW_NORMAL 0, PRESSED 1, HOVER 2, DISABLED 3
  get_minimum_size() { const t = super.get_minimum_size(); return new Vector2(t.x + 16, t.y + 8); }
  _gui_event(ev) {
    if (!this.disabled) {
      if (ev instanceof InputEventMouseButton && ev.button_index === 1) {
        if (ev.pressed) { this._down = true; this.emit_signal('button_down'); this.accept_event(); }
        else if (this._down) {
          this._down = false; this.emit_signal('button_up'); this.accept_event();
          if (this.has_point(ev.position)) { if (this.toggle_mode) this.button_pressed = !this._button_pressed; this.emit_signal('pressed'); }
        }
      }
    }
    super._gui_event(ev);
  }
  _draw_ui(r, xf, mod) {
    const s = this.size; const mode = this.get_draw_mode();
    const bg = [this.get_theme_color('normal', new Color(0.21, 0.24, 0.29)), this.get_theme_color('pressed', new Color(0.1, 0.12, 0.15)), this.get_theme_color('hover', new Color(0.3, 0.34, 0.4)), this.get_theme_color('disabled', new Color(0.2, 0.2, 0.2, 0.5))][mode];
    if (!this.flat) r._quad(xf, 0, 0, s.x, s.y, 0, 0, 1, 1, bg.mul(mod), null);
    this._draw_text(r, xf, mod, this.get_theme_color(mode === 3 ? 'font_disabled_color' : 'font_color', mode === 3 ? new Color(0.7, 0.7, 0.7, 0.5) : new Color(0.875, 0.875, 0.875)), new Rect2(new Vector2(), s));
  }
}
Button.signals = ['pressed', 'button_down', 'button_up', 'toggled'];
ClassDB.register(Button, 'Button', [{ name: 'disabled', type: 'bool' }, { name: 'toggle_mode', type: 'bool' }, { name: 'flat', type: 'bool' }]);

// GUI dispatch: hit-test Controls top-most first (reverse draw order) with mouse_filter semantics.
function _gui_input_dispatch(tree, ev) {
  const isMouse = ev instanceof InputEventMouseButton || ev instanceof InputEventMouseMotion;
  if (!isMouse) return;
  const vp = tree.root; const gui = vp._gui;
  const items = extract_canvas_items(tree).filter((n) => n instanceof Control);
  const cam = vp._camera_2d && vp._camera_2d._tree && vp._camera_2d.enabled ? vp._camera_2d : null;
  const canvasT = cam ? cam.get_canvas_transform(vp._size) : vp.canvas_transform;
  const local = (c) => Transform2D.IDENTITY.mul(canvasT).mul(c.get_global_transform()).affine_inverse().xform(ev.position);
  const pick = () => { for (let i = items.length - 1; i >= 0; i--) { const c = items[i]; if (c.mouse_filter === MouseFilter.MOUSE_FILTER_IGNORE) continue; if (c.has_point(local(c))) return c; } return null; };
  const send = (target) => { // deliver with local coordinates, bubbling through PASS parents
    let c = target;
    while (c && !vp._input_handled) {
      if (c instanceof Control && c.mouse_filter !== MouseFilter.MOUSE_FILTER_IGNORE) {
        const lp = local(c); const saved = ev.position; ev.position = lp; c._gui_event(ev); ev.position = saved;
        if (c.mouse_filter === MouseFilter.MOUSE_FILTER_STOP) { vp.set_input_as_handled(); break; }
      }
      c = c._parent instanceof Control ? c._parent : null;
    }
  };
  if (ev instanceof InputEventMouseMotion) {
    const over = pick();
    if (over !== gui.hovered) {
      if (gui.hovered && !gui.hovered._freed) { gui.hovered._hovered = false; gui.hovered.emit_signal('mouse_exited'); gui.hovered.queue_redraw(); }
      gui.hovered = over; if (over) { over._hovered = true; over.emit_signal('mouse_entered'); over.queue_redraw(); }
    }
    const target = gui.pressed && !gui.pressed._freed ? gui.pressed : over; if (target) send(target);
    return;
  }
  if (ev.pressed) { const t = pick(); gui.pressed = t; if (t) send(t); }
  else { const t = gui.pressed && !gui.pressed._freed ? gui.pressed : pick(); gui.pressed = null; if (t) send(t); }
}

// ── Profiler: ring buffer of per-frame timings and counters.
const Profiler = {
  capacity: 600, _frames: [], recording: false,
  start() { this._frames.length = 0; this.recording = true; }, stop() { this.recording = false; },
  _sample() {
    if (!this.recording) return;
    const L = Performance._last; const draw = Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME);
    this._frames.push({ frame_ms: L.frame, physics_ms: L.physics, process_ms: L.process, render_ms: L.render, physics_steps: L.steps, draw_calls: draw,
      objects: ObjectDB.get_object_count(), nodes: _nodeLiveCount, resources: Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
      gpu_objects: [..._liveBackends].reduce((s, b) => s + b.stats.total_objects(), 0) });
    if (this._frames.length > this.capacity) this._frames.shift();
  },
  frames() { return this._frames.slice(); },
  report() {
    const f = this._frames; const out = { frames: f.length };
    if (!f.length) return out;
    for (const k of ['frame_ms', 'physics_ms', 'process_ms', 'render_ms', 'draw_calls']) {
      const v = f.map((x) => x[k]).sort((a, b) => a - b);
      out[k] = { avg: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))], max: v[v.length - 1] };
    }
    const last = f[f.length - 1]; out.objects = last.objects; out.nodes = last.nodes; out.resources = last.resources; out.gpu_objects = last.gpu_objects;
    const tot = f.reduce((s, x) => s + x.frame_ms, 0); out.fps_cpu_bound = tot > 0 ? (1000 * f.length) / tot : 0; out.fps = Engine.get_frames_per_second();
    return out;
  },
};
const _origRecord = Performance._record;
Performance._record = function (...a) { _origRecord.apply(this, a); Profiler._sample(); };

Object.assign(_ext, {
  Gradient, CPUParticles2D, Serializer, ResourceSaver, HTTPRequest, HTTPMethod, HTTPResult, WebSocketPeer,
  Control, Label, Button, ColorRect, Panel, LayoutPreset, MouseFilter, HorizontalAlignment, VerticalAlignment, Profiler,
});

// §13 ────────────────────────────────────────────────────────────────────────
const _exports = {
  VERSION, GODOT_REFERENCE_VERSION, Config, Err, Log, LogLevel,
  set_debug(b) { Config.debug = !!b; Log.level = b ? LogLevel.INFO : LogLevel.WARNING; },
  Math: MathUtil, Vector2, Vector3, Vector4, Quaternion, Basis, Transform2D, Transform3D, AABB, Rect2, Color, Plane, Mat4,
  Object: GObject, ObjectDB, ClassDB, Callable, Signal, ConnectFlags, MessageQueue, Resource, ResourceStats, is_instance_valid,
  Engine, Performance,
  NodePath, Node, NOTIFICATION, ProcessMode, Viewport, Window, SceneTree, SceneTreeTimer, CanvasItem, Node2D, Node3D,
  PackedScene, VariantCodec, get_live_node_count,
};
Object.assign(_exports, _ext);
const GodotJS = Object.freeze(_exports);
Object.defineProperty(global, 'GodotJS', { value: GodotJS, writable: false, configurable: false, enumerable: false });
})(typeof window !== 'undefined' ? window : globalThis);
