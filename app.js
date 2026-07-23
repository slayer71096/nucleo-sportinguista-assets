/* MENU vem agora do separador "Produtos" da Google Sheet, carregado no arranque */
let MENU = {};

const STATUS_ORDER = ['novo', 'entregue', 'pago'];
const STATUS_LABEL = { novo: 'Novo', entregue: 'Entregue', pago: 'Pago' };
const MEMBER_STATUS_LABEL = { novo: 'Por entregar', entregue: 'Por pagar', pago: 'Pago' };

// Endereço da tua Web App do Apps Script (o link que termina em /exec).
// É só a "base de dados" agora — já não mostra a app se abrires diretamente.
const API_BASE = 'https://script.google.com/macros/s/AKfycbyujWE0xxNi4HyV7uOt9J4ob2_67HI34aBznkyPIFL5ZU67_K_aBe4i7DZAw2dRJDXy/exec';

// Link do balcão: abrir esta app com ?balcao=1 no fim do URL dá acesso direto
// à vista de pedidos, sem passar pela autenticação de sócio.
const isStaffLink = new URLSearchParams(window.location.search).get('balcao') === '1';

// O manifest.json estático não sabe se isto é o link do balcão ou dos sócios.
// Substituímo-lo por um gerado na hora, com o URL exato desta página como
// start_url — assim o ícone instalado abre sempre no sítio certo.
(function setupManifest() {
    try {
        const manifest = {
            name: isStaffLink ? 'Núcleo Sporting Clube de Portugal de Viseu — Balcão' : 'Núcleo Sporting Clube de Portugal de Viseu',
            short_name: isStaffLink ? 'Balcão' : 'Núcleo Sporting Clube de Portugal de Viseu',
            start_url: window.location.href,
            id: window.location.href,
            display: 'standalone',
            background_color: '#0C2B1B',
            theme_color: '#0C2B1B',
            icons: [
                { src: 'https://raw.githubusercontent.com/slayer71096/nucleo-sportinguista-assets/main/icone-leao-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'https://raw.githubusercontent.com/slayer71096/nucleo-sportinguista-assets/main/icone-leao-512.png', sizes: '512x512', type: 'image/png' }
            ]
        };
        const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
        document.getElementById('app-manifest').href = URL.createObjectURL(blob);
    } catch (e) { console.error('Erro a configurar manifest', e); }
})();

let authenticated = false;
let phone = '';
let memberName = '';
let authError = '';
let checkingAuth = false;
let activeCat = '';
let cart = {};
let mesa = '';
let pollTimer = null;
let showSummary = false;
let staffLink = window.location.origin + window.location.pathname;
let qrPanelOpen = false;
let lastStaffSnapshot = '';
let pedidosCollapsed = false;
let contasCollapsed = false;
let collapsedTickets = {};

const app = document.getElementById('app');
if (isStaffLink) app.classList.add('staff-mode');

/* ---------- ligação à API (Google Apps Script como backend) ---------- */
async function apiGet(action, params) {
    const url = new URL(API_BASE);
    url.searchParams.set('action', action);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
}
async function apiPost(action, payload) {
    // Content-Type 'text/plain' evita o pre-flight CORS que o Apps Script não sabe responder.
    const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...payload })
    });
    return res.json();
}

function euros(n) { return n.toFixed(2).replace('.', ',') + ' 🦁'; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function normalizePhone(p) { return (p || '').replace(/\D/g, ''); }

async function loadMenu() {
    try {
        MENU = await apiGet('getMenu');
        if (!MENU[activeCat]) activeCat = Object.keys(MENU)[0] || '';
    } catch (e) { MENU = {}; console.error('Erro a carregar menu', e); }
}

async function loadOrders() {
    try { return await apiGet('getOrders'); }
    catch (e) { console.error('Erro a carregar pedidos', e); return []; }
}
async function addOrder(order) {
    try { await apiPost('addOrder', { order }); }
    catch (e) { console.error('Erro a guardar pedido', e); }
}
async function advanceStatus(id) {
    const list = await loadOrders();
    const idx = list.findIndex(o => o.id === id);
    if (idx === -1) return;
    const next = STATUS_ORDER[STATUS_ORDER.indexOf(list[idx].status) + 1];
    if (!next) return;
    try { await apiPost('updateOrderStatus', { id, status: next }); }
    catch (e) { console.error('Erro a avançar estado', e); }
    render();
}
async function markPaid(phone) {
    try { await apiPost('markMemberPaid', { phone }); }
    catch (e) { console.error('Erro a marcar como pago', e); }
    render();
}

function timeAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'agora';
    if (mins === 1) return '1 min';
    return mins + ' min';
}

function cartCount() { return Object.values(cart).reduce((a, b) => a + b, 0); }
function cartTotal() {
    let t = 0;
    const allItems = Object.values(MENU).flat();
    for (const [id, qty] of Object.entries(cart)) {
        const it = allItems.find(i => i.id === id);
        if (it) t += it.price * qty;
    }
    return t;
}
function setQty(id, delta) {
    const q = (cart[id] || 0) + delta;
    if (q <= 0) delete cart[id];
    else cart[id] = q;
    render();
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(render, 4000);
}
function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}
let myOrdersTimer = null;
function startMyOrdersPolling() {
    if (myOrdersTimer) clearInterval(myOrdersTimer);
    myOrdersTimer = setInterval(renderMyOrders, 4000);
}
function stopMyOrdersPolling() {
    if (myOrdersTimer) clearInterval(myOrdersTimer);
    myOrdersTimer = null;
}

async function render() {
    if (isStaffLink) { await renderStaff(); return; }
    if (!authenticated) { renderPhoneAuth(); return; }
    await renderCliente();
}

async function tryAuth() {
    checkingAuth = true;
    renderPhoneAuth();
    const clean = normalizePhone(phone);
    let result = { found: false };
    try { result = await apiGet('checkMember', { phone: clean }); }
    catch (e) { console.error('Erro a verificar sócio', e); }
    checkingAuth = false;
    if (!clean || !result.found) {
        authError = 'Número não reconhecido. Confirma o número ou fala com o balcão.';
        renderPhoneAuth();
        return;
    }
    authError = '';
    memberName = result.name;
    authenticated = true;
    render();
}

function renderPhoneAuth() {
    stopPolling();
    stopMyOrdersPolling();
    lastMyOrdersSnapshot = '';
    app.innerHTML = `
    <div class="landing">
      <div class="mark-big">🦁</div>
      <div>
        <h1>Núcleo Sporting Clube de Portugal de Viseu</h1>
        <p>Introduz o teu número de telemóvel de sócio para fazeres o teu pedido.</p>
      </div>
      <div class="mesa-field" style="width:100%;max-width:300px;padding:0;">
        <label>Número de telemóvel</label>
        <input id="phone-input" inputmode="tel" placeholder="ex: 912 345 678" value="${phone}">
      </div>
      ${authError ? `<div class="warning-box" style="max-width:300px;"><span class="icon">⚠️</span><span>${authError}</span></div>` : ''}
      <button class="btn-primary" id="phone-submit" style="width:100%;max-width:300px;padding:15px 30px;" ${checkingAuth ? 'disabled' : ''}>${checkingAuth ? 'A verificar...' : 'Entrar'}</button>
    </div>
  `;
    const input = document.getElementById('phone-input');
    input.oninput = (e) => { phone = e.target.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') tryAuth(); };
    document.getElementById('phone-submit').onclick = tryAuth;
}

async function renderCliente() {
    if (showSummary) { renderSummarySheet(); return; }
    stopPolling();
    const items = MENU[activeCat] || [];
    app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="mark">🦁</div>
        <div><h1>Núcleo Sporting Clube de Portugal de Viseu</h1><span>Olá, ${memberName}</span></div>
      </div>
      <button class="icon-btn" id="back-btn">← Sair</button>
    </div>
    <div class="mesa-field">
      <label>Número da mesa</label>
      <input id="mesa-input" inputmode="numeric" placeholder="ex: 7" value="${mesa}">
    </div>
    <div class="cats">
      ${Object.keys(MENU).map(c => `<button class="cat-btn ${c === activeCat ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
    </div>
    <div class="menu-grid">
      ${items.map(it => `
        <div class="item-card">
          <div><b>${it.name}</b><div class="price">${euros(it.price)}</div></div>
          <div class="qty-row">
            ${cart[it.id] ? `
              <div class="stepper">
                <button data-minus="${it.id}">−</button>
                <span class="n">${cart[it.id]}</span>
                <button data-plus="${it.id}">+</button>
              </div>
            ` : `<button class="add-btn" data-plus="${it.id}">Adicionar</button>`}
          </div>
        </div>
      `).join('')}
    </div>
    ${cartCount() > 0 ? `
      <div class="cart-bar">
        <div class="inner" id="cart-cta">
          <span><span class="count">${cartCount()}</span>Ver pedido</span>
          <span class="total">${euros(cartTotal())}</span>
        </div>
      </div>
    ` : ''}
  `;
    document.getElementById('back-btn').onclick = () => {
        authenticated = false; phone = ''; memberName = ''; mesa = ''; cart = {}; render();
    };
    document.getElementById('mesa-input').oninput = (e) => { mesa = e.target.value; };
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { activeCat = b.dataset.cat; render(); });
    document.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => setQty(b.dataset.plus, 1));
    document.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => setQty(b.dataset.minus, -1));
    const cta = document.getElementById('cart-cta');
    if (cta) cta.onclick = () => { showSummary = true; render(); };
    const activeCatBtn = document.querySelector('.cat-btn.active');
    if (activeCatBtn) activeCatBtn.scrollIntoView({ inline: 'center', block: 'nearest' });

    renderMyOrders();
    startMyOrdersPolling();
}

let lastMyOrdersSnapshot = '';
async function renderMyOrders() {
    if (!authenticated) return;
    const list = await loadOrders();
    const myPhone = normalizePhone(phone);
    const mine = list.filter(o => o.phone === myPhone && o.status !== 'pago').sort((a, b) => b.ts - a.ts);
    const existing = document.getElementById('my-orders-section');
    if (mine.length === 0) {
        if (existing) existing.remove();
        lastMyOrdersSnapshot = '';
        return;
    }
    const snapshot = JSON.stringify(mine.map(o => o.id + ':' + o.status));
    if (snapshot === lastMyOrdersSnapshot && existing) return;
    lastMyOrdersSnapshot = snapshot;
    const grandTotal = mine.reduce((sum, o) => sum + o.total, 0);
    const html = `<h3>Os teus pedidos</h3>` + mine.map(o => `
    <div class="ticket">
      <div class="ticket-head">
        <span class="mesa-tag" style="font-size:14px;">Mesa ${o.mesa}</span>
        <span class="status-pill status-${o.status}">${MEMBER_STATUS_LABEL[o.status]}</span>
      </div>
      <div class="ticket-items">${o.items.map(i => `<div><span class="qty">${i.qty}×</span>${i.name}</div>`).join('')}</div>
      <div class="tab-total"><span>${euros(o.total)}</span></div>
    </div>
  `).join('') + `<div class="my-orders-total">Total por pagar <span>${euros(grandTotal)}</span></div>`;
    if (existing) {
        existing.innerHTML = html;
    } else {
        const el = document.createElement('div');
        el.id = 'my-orders-section';
        el.className = 'my-orders';
        el.innerHTML = html;
        app.appendChild(el);
    }
}

function renderSummarySheet() {
    const allItems = Object.values(MENU).flat();
    const lines = Object.entries(cart).map(([id, qty]) => {
        const it = allItems.find(i => i.id === id);
        return { ...it, qty };
    });
    app.innerHTML = `
    <div class="overlay">
      <div class="sheet">
        <h2>Confirmar pedido — Mesa ${mesa || '?'}</h2>
        ${lines.map(l => `
          <div class="sum-row">
            <span class="name">${l.qty}× ${l.name}</span>
            <span class="p">${euros(l.price * l.qty)}</span>
          </div>
        `).join('')}
        <div class="sum-total"><span>Total</span><span class="v">${euros(cartTotal())}</span></div>
        <div class="sheet-actions">
          <button class="btn-secondary" id="cancel-btn">Voltar</button>
          <button class="btn-primary" id="confirm-btn" ${!mesa ? 'disabled title="Indica a mesa"' : ''}>Enviar pedido</button>
        </div>
        ${!mesa ? '<div class="warning-box"><span class="icon">⚠️</span><span>Indica o número da mesa antes de enviar.</span></div>' : ''}
      </div>
    </div>
  `;
    document.getElementById('cancel-btn').onclick = () => { showSummary = false; render(); };
    document.getElementById('confirm-btn').onclick = async () => {
        if (!mesa) return;
        const btn = document.getElementById('confirm-btn');
        btn.disabled = true; btn.textContent = 'A enviar...';
        const order = {
            id: uid(),
            mesa: mesa,
            phone: normalizePhone(phone),
            memberName: memberName,
            items: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price })),
            total: cartTotal(),
            status: 'novo',
            ts: Date.now()
        };
        await addOrder(order);
        cart = {};
        showSummary = false;
        renderConfirm(order);
    };
}

function renderConfirm(order) {
    app.innerHTML = `
    <div class="confirm">
      <div class="stamp">✓</div>
      <h2>Pedido enviado!</h2>
      <p>Mesa ${order.mesa} · total ${euros(order.total)}</p>
      <span class="ticket-id">#${order.id.slice(-5)}</span>
      <button class="btn-primary" id="new-order-btn" style="margin-top:18px;width:100%;max-width:300px;padding:14px 24px;">Fazer outro pedido</button>
    </div>
  `;
    document.getElementById('new-order-btn').onclick = () => { render(); };
    startPolling();
}

async function renderStaff() {
    const list = await loadOrders();
    const snapshot = JSON.stringify(list.map(o => o.id + ':' + o.status).sort());
    if (snapshot === lastStaffSnapshot) { return; } // nada mudou, não mexer no ecrã
    lastStaffSnapshot = snapshot;

    const pending = list.filter(o => o.status === 'novo').sort((a, b) => a.ts - b.ts);
    const openOrders = list.filter(o => o.status !== 'novo' && o.status !== 'pago');

    // Agrupar contas em aberto por sócio (telemóvel identifica de forma única)
    const tabsMap = {};
    openOrders.sort((a, b) => a.ts - b.ts).forEach(o => {
        const key = o.phone || o.memberName || 'sem-nome';
        if (!tabsMap[key]) tabsMap[key] = { phone: o.phone, name: o.memberName || 'Sócio', lines: [], total: 0 };
        o.items.forEach(i => {
            tabsMap[key].lines.push(i);
            tabsMap[key].total += (i.price * i.qty);
        });
    });
    const tabs = Object.values(tabsMap);

    const pendingTicketHtml = (o) => `
    <div class="ticket ${collapsedTickets['o-' + o.id] ? 'ticket-collapsed' : ''}" id="ticket-o-${o.id}">
      <div class="ticket-head ticket-toggle" data-toggle="o-${o.id}">
        <div>
          <span class="mesa-tag">Mesa ${o.mesa}</span>
          ${o.memberName ? `<div class="member-name">${o.memberName}</div>` : ''}
        </div>
        <span class="chevron">▾</span>
      </div>
      <div class="ticket-body">
        <div class="ticket-items">${o.items.map(i => `<div><span class="qty">${i.qty}×</span>${i.name}</div>`).join('')}</div>
        <div class="ticket-foot">
          <button class="advance-btn" data-advance="${o.id}">Entregue →</button>
        </div>
      </div>
    </div>
  `;

    const tabHtml = (t) => `
    <div class="ticket ${collapsedTickets['t-' + t.phone] ? 'ticket-collapsed' : ''}" id="ticket-t-${t.phone}">
      <div class="ticket-head ticket-toggle" data-toggle="t-${t.phone}">
        <div class="member-name" style="font-size:16px;">${t.name}</div>
        <span class="chevron">▾</span>
      </div>
      <div class="ticket-body">
        <div class="ticket-items">${t.lines.map(i => `<div style="display:flex;justify-content:space-between;"><span><span class="qty">${i.qty}×</span>${i.name}</span><span class="mono">${euros(i.price)}</span></div>`).join('')}</div>
        <div class="tab-total">Total: <span>${euros(t.total)}</span></div>
        <div class="ticket-foot">
          <button class="advance-btn ready" data-paid="${t.phone}">✓ Pago</button>
        </div>
      </div>
    </div>
  `;

    app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="mark">🧾</div>
        <div><h1>Núcleo Sporting Clube de Portugal de Viseu</h1><span>Pedidos por atender · ${pending.length}</span></div>
      </div>
    </div>
    <div class="staff-toolbar">
      <small>Atualiza automaticamente a cada 4s · dados na Google Sheet</small>
    </div>
    <details class="qr-panel" id="qr-details" ${qrPanelOpen ? 'open' : ''}>
      <summary>📎 Configurar link/QR code para os sócios (mesas)</summary>
      <p>Cola aqui o link desta app <b>sem</b> "?balcao=1" no fim, para gerar o QR code a colocar nas mesas. Para voltares a esta vista de balcão, adiciona <span class="mono">?balcao=1</span> ao fim do link.</p>
      <input id="link-input" placeholder="https://script.google.com/macros/s/.../exec" value="${staffLink}">
      <div id="qrcode"></div>
    </details>
    ${list.length === 0 ? `
      <div class="empty-state"><div class="e">🫙</div>Ainda não há pedidos.</div>
    ` : `
      <div class="board">
        <div class="board-col col-novo ${pedidosCollapsed ? 'collapsed' : ''}" id="col-pedidos">
          <div class="board-col-head" id="head-pedidos">
            <span class="head-label"><span class="chevron">▾</span>Pedidos</span>
            <span class="board-count">${pending.length}</span>
          </div>
          <div class="board-col-body">
            ${pending.length ? pending.map(pendingTicketHtml).join('') : `<div class="board-empty">Sem pedidos</div>`}
          </div>
        </div>
        <div class="board-col col-contas ${contasCollapsed ? 'collapsed' : ''}" id="col-contas">
          <div class="board-col-head" id="head-contas">
            <span class="head-label"><span class="chevron">▾</span>Contas em Aberto</span>
            <span class="board-count">${tabs.length}</span>
          </div>
          <div class="board-col-body">
            ${tabs.length ? tabs.map(tabHtml).join('') : `<div class="board-empty">Sem contas em aberto</div>`}
          </div>
        </div>
      </div>
    `}
  `;
    document.getElementById('head-pedidos') && (document.getElementById('head-pedidos').onclick = () => {
        pedidosCollapsed = !pedidosCollapsed;
        document.getElementById('col-pedidos').classList.toggle('collapsed', pedidosCollapsed);
    });
    document.getElementById('head-contas') && (document.getElementById('head-contas').onclick = () => {
        contasCollapsed = !contasCollapsed;
        document.getElementById('col-contas').classList.toggle('collapsed', contasCollapsed);
    });
    document.querySelectorAll('[data-toggle]').forEach(h => h.onclick = (ev) => {
        if (ev.target.closest('[data-advance],[data-paid]')) return;
        const key = h.dataset.toggle;
        collapsedTickets[key] = !collapsedTickets[key];
        document.getElementById('ticket-' + key).classList.toggle('ticket-collapsed', collapsedTickets[key]);
    });
    document.querySelectorAll('[data-advance]').forEach(b => b.onclick = () => {
        if (b.disabled) return;
        b.disabled = true; b.textContent = 'A atualizar...';
        advanceStatus(b.dataset.advance);
    });
    document.querySelectorAll('[data-paid]').forEach(b => b.onclick = () => {
        if (b.disabled) return;
        b.disabled = true; b.textContent = 'A fechar conta...';
        markPaid(b.dataset.paid);
    });

    const linkInput = document.getElementById('link-input');
    linkInput.oninput = () => { staffLink = linkInput.value; drawQR(staffLink); };
    drawQR(staffLink || '');
    document.getElementById('qr-details').addEventListener('toggle', (e) => { qrPanelOpen = e.target.open; });

    startPolling();
}

function drawQR(text) {
    const holder = document.getElementById('qrcode');
    if (!holder) return;
    holder.innerHTML = '';
    if (!text) { holder.style.display = 'none'; return; }
    holder.style.display = 'flex';
    try {
        new QRCode(holder, { text, width: 150, height: 150, colorDark: '#0C2B1B', colorLight: '#ffffff' });
    } catch (e) { console.error(e); }
}

(async function init() {
    await loadMenu();
    render();
})();