// 실행취소 · 다시실행 — 지금 편집 중인 글 하나에만 쓰는 메모리 기록 (저장소/DB에는 아무것도 쓰지 않아요)
// 글 전체를 복사해 두지 않고 "어디가 무엇에서 무엇으로 바뀌었는지"만 적어 두어요.
export function diffText(a, b) {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0; while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0; while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  // 한글·이모지 같은 두 칸짜리 글자를 반으로 가르지 않게 경계를 맞춰요
  const hi = c => c >= 0xD800 && c <= 0xDBFF, lo = c => c >= 0xDC00 && c <= 0xDFFF;
  if (p > 0 && p < a.length && lo(a.charCodeAt(p)) && hi(a.charCodeAt(p - 1))) p--;
  if (s > 0 && lo(a.charCodeAt(a.length - s)) && hi(a.charCodeAt(a.length - s - 1))) s--;
  return { at: p, del: a.slice(p, a.length - s), ins: b.slice(p, b.length - s) };
}
export class UndoStack {
  constructor({ maxEntries = 300, maxChars = 2000000, mergeMs = 1200 } = {}) { this.maxEntries = maxEntries; this.maxChars = maxChars; this.mergeMs = mergeMs; this.reset(''); }
  reset(text) { this.stack = []; this.idx = 0; this.last = text || ''; this.seal = true; this.chars = 0; }
  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.stack.length; }
  // 글이 next로 바뀌었다고 알려 줘요. typing=true면 타자·삭제처럼 이어지는 입력은 한 덩어리로 묶어요.
  push(next, typing = false, now = Date.now()) {
    const d = diffText(this.last, next); if (!d) return false;
    if (this.idx < this.stack.length) { this.stack.length = this.idx; this._recount(); }
    const p = this.stack[this.idx - 1];
    if (typing && !this.seal && p && now - p.t < this.mergeMs && d.ins.length + d.del.length <= 4 && !/\n/.test(d.ins + d.del)) {
      if (!p.del && !d.del && p.ins && d.at === p.at + p.ins.length && p.ins.length < 80) { p.ins += d.ins; p.t = now; this.chars += d.ins.length; this.last = next; return true; } // 이어 쓰기
      if (!p.ins && !d.ins && p.del && d.at + d.del.length === p.at && p.del.length < 80) { p.at = d.at; p.del = d.del + p.del; p.t = now; this.chars += d.del.length; this.last = next; return true; } // 지우개(←)
      if (!p.ins && !d.ins && p.del && d.at === p.at && p.del.length < 80) { p.del += d.del; p.t = now; this.chars += d.del.length; this.last = next; return true; } // 지우개(Delete)
    }
    this.stack.push({ at: d.at, del: d.del, ins: d.ins, t: now }); this.idx = this.stack.length; this.chars += d.del.length + d.ins.length;
    while (this.stack.length > 1 && (this.stack.length > this.maxEntries || this.chars > this.maxChars)) { const o = this.stack.shift(); this.chars -= o.del.length + o.ins.length; this.idx--; }
    this.seal = false; this.last = next; return true;
  }
  _recount() { this.chars = this.stack.reduce((n, e) => n + e.del.length + e.ins.length, 0); }
  // 되돌릴 때 글에 적용할 변경 {at, remove, insert, text}를 줘요. 글이 기록과 맞지 않으면 기록을 비우고 null.
  undo(cur) {
    if (!this.canUndo) return null;
    if (cur !== this.last) { this.reset(cur); return null; }
    const e = this.stack[this.idx - 1];
    if (cur.slice(e.at, e.at + e.ins.length) !== e.ins) { this.reset(cur); return null; }
    this.idx--; this.seal = true; const text = cur.slice(0, e.at) + e.del + cur.slice(e.at + e.ins.length); this.last = text;
    return { at: e.at, remove: e.ins.length, insert: e.del, text };
  }
  redo(cur) {
    if (!this.canRedo) return null;
    if (cur !== this.last) { this.reset(cur); return null; }
    const e = this.stack[this.idx];
    if (cur.slice(e.at, e.at + e.del.length) !== e.del) { this.reset(cur); return null; }
    this.idx++; this.seal = true; const text = cur.slice(0, e.at) + e.ins + cur.slice(e.at + e.del.length); this.last = text;
    return { at: e.at, remove: e.del.length, insert: e.ins, text };
  }
}
