// スタッフ画面の写真グリッド: 複数選択 → 削除 / 非表示 / 別グループへ移動
export function initGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const bar = document.getElementById('selbar')!, cnt = document.getElementById('selcount')!;
  const sel = new Set<string>();
  const update = () => { cnt.textContent = String(sel.size); bar.hidden = sel.size === 0; };
  grid.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    if (!cell) return;
    const id = cell.dataset.id!;
    sel.has(id) ? sel.delete(id) : sel.add(id);
    cell.classList.toggle('sel', sel.has(id));
    update();
  });
  async function act(body: Record<string, unknown>) {
    const r = await fetch('/api/admin/photos', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...sel], ...body }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error === 'sold' ? '購入履歴のある写真は移動できません' : j.error === 'duplicate_in_target' ? '移動先に同じ写真があります' : `失敗しました (${j.error ?? r.status})`); return; }
    if (j.blocked) alert(`${j.blocked} 枚は購入履歴があるため削除しませんでした`);
    location.reload();
  }
  document.getElementById('sel-delete')!.addEventListener('click', () => { if (confirm(`${sel.size} 枚を削除します。元に戻せません。よろしいですか？`)) act({ action: 'delete' }); });
  document.getElementById('sel-hide')!.addEventListener('click', () => act({ action: 'hide' }));
  document.getElementById('sel-show')!.addEventListener('click', () => act({ action: 'show' }));
  document.getElementById('sel-move')!.addEventListener('click', () => {
    const to = (document.getElementById('move-to') as unknown as HTMLSelectElement).value;
    if (to && confirm(`${sel.size} 枚を移動します。よろしいですか？`)) act({ action: 'move', toGroupId: to });
  });
  document.getElementById('sel-clear')!.addEventListener('click', () => {
    sel.clear(); grid.querySelectorAll('.sel').forEach((c) => c.classList.remove('sel')); update();
  });
}
