'use strict';
// Obras V&M: diário de obra com fotos e relatório de visita em PDF.
// Todos os dados ficam SOMENTE neste aparelho (IndexedDB). Nada é enviado para servidor.

const EMPRESA = {
  nome: 'V&M Engenharia',
  cnpj: '46.301.194/0001-66',
  resp: 'Eng. Vinicius Melin',
  crea: 'CREA PR-184877/D',
  cidade: 'Curitiba/PR'
};
const CLIMAS = ['', 'Ensolarado', 'Parcialmente nublado', 'Nublado', 'Garoa', 'Chuvoso'];
const CONDICOES = ['', 'Praticável', 'Parcialmente praticável', 'Impraticável'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ---------------------------------------------------------------- banco
let _db;
function abrirBanco() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, erro) => {
    const r = indexedDB.open('obras-vm', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('obras', { keyPath: 'id' });
      db.createObjectStore('visitas', { keyPath: 'id' }).createIndex('obraId', 'obraId');
      const f = db.createObjectStore('fotos', { keyPath: 'id' });
      f.createIndex('visitaId', 'visitaId');
      f.createIndex('obraId', 'obraId');
    };
    r.onsuccess = () => { _db = r.result; ok(_db); };
    r.onerror = () => erro(r.error);
  });
}
function tx(loja, modo, fn) {
  return abrirBanco().then((db) => new Promise((ok, erro) => {
    const t = db.transaction(loja, modo);
    let res;
    const req = fn(t.objectStore(loja));
    if (req) req.onsuccess = () => { res = req.result; };
    t.oncomplete = () => ok(res);
    t.onerror = t.onabort = () => erro(t.error);
  }));
}
const pegar = (l, id) => tx(l, 'readonly', (s) => s.get(id));
const gravar = (l, o) => tx(l, 'readwrite', (s) => s.put(o));
const apagar = (l, id) => tx(l, 'readwrite', (s) => s.delete(id));
const todos = (l) => tx(l, 'readonly', (s) => s.getAll());
const porIndice = (l, i, v) => tx(l, 'readonly', (s) => s.index(i).getAll(v));

// ---------------------------------------------------------------- utilidades
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const agora = () => new Date().toISOString();
function hoje() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function dataBR(iso) { if (!iso) return ''; const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; }
function dataExtenso(iso) { const [a, m, d] = iso.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${a}`; }
const porData = (a, b) => (a.data || '').localeCompare(b.data || '') || (a.criadoEm || '').localeCompare(b.criadoEm || '');
function slug(s) { return String(s || 'obra').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'obra'; }
function opcoes(lista, atual) { return lista.map((o) => `<option value="${esc(o)}"${o === atual ? ' selected' : ''}>${o ? esc(o) : '—'}</option>`).join(''); }

let _avisoTimer;
function aviso(txt, ms = 2600) {
  const el = $('#aviso'); el.textContent = txt; el.hidden = false;
  clearTimeout(_avisoTimer); _avisoTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function blobParaDataUrl(blob) {
  return new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => erro(r.error); r.readAsDataURL(blob); });
}
function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
// Tenta abrir o "Compartilhar" do celular (WhatsApp, Nextcloud...). Se não der, baixa o arquivo.
async function compartilharOuBaixar(blob, nome, tipo, titulo) {
  const arq = new File([blob], nome, { type: tipo });
  if (navigator.canShare && navigator.canShare({ files: [arq] })) {
    try { await navigator.share({ files: [arq], title: titulo }); return 'compartilhado'; }
    catch (e) {
      if (e.name === 'AbortError') return 'cancelado';
      if (e.name === 'NotAllowedError') return 'precisa-toque';
    }
  }
  baixar(blob, nome);
  return 'baixado';
}
async function pedirArmazenamentoFixo() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* sem suporte */ }
}

// Reduz a foto (máx. 1600 px, JPG 80%). Redesenhar no canvas também apaga EXIF/GPS.
async function processarFoto(arquivo) {
  let img;
  try { img = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); }
  catch (e) {
    img = await new Promise((ok, erro) => {
      const i = new Image(); const u = URL.createObjectURL(arquivo);
      i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = () => erro(new Error('Formato de imagem não suportado')); i.src = u;
    });
  }
  const max = 1600; const r = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * r); const h = Math.round(img.height * r);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
  return { blob, largura: w, altura: h };
}

// ---------------------------------------------------------------- telas
let _salvarPendente = null;   // salvamento automático que ainda não rodou
let _urls = [];               // endereços temporários das miniaturas
function limparUrls() { _urls.forEach((u) => URL.revokeObjectURL(u)); _urls = []; }

async function rota() {
  if (_salvarPendente) await _salvarPendente();
  limparUrls();
  const [tela, id] = location.hash.replace(/^#\/?/, '').split('/');
  const main = $('#tela');
  try {
    if (tela === 'obra') await telaObra(main, id);
    else if (tela === 'visita') await telaVisita(main, id);
    else await telaInicio(main);
  } catch (e) {
    console.error(e);
    main.innerHTML = `<p>Algo deu errado: ${esc(e.message)}</p><a class="btn sec" href="#/">Voltar ao início</a>`;
  }
  window.scrollTo(0, 0);
}

async function telaInicio(main) {
  const obras = (await todos('obras')).sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || ''));
  const visitas = await todos('visitas');
  const qtd = (id) => visitas.filter((v) => v.obraId === id).length;
  let uso = '';
  try { const e = await navigator.storage.estimate(); uso = `Espaço usado no aparelho: ${(e.usage / 1048576).toFixed(1)} MB.`; } catch (e) { /* sem suporte */ }

  main.innerHTML = `
    <h1>Obras</h1>
    <p class="sub">Diário de obra, fotos e relatório de visita.</p>
    ${obras.length ? `<ul class="lista">${obras.map((o) => `
      <li><a class="item" href="#/obra/${o.id}">
        <strong>${esc(o.nome)}</strong>
        <small>${esc([o.cliente, o.local].filter(Boolean).join(' · '))}${o.cliente || o.local ? ' · ' : ''}${qtd(o.id)} visita(s)</small>
      </a></li>`).join('')}</ul>`
      : '<p class="vazio">Nenhuma obra ainda. Toque em <b>+ Nova obra</b> para começar.</p>'}

    <h2>Cópia de segurança</h2>
    <div class="card">
      <p class="sub" style="margin:0">Os dados ficam só neste aparelho. Faça um backup no fim de cada visita e salve o arquivo no Nextcloud.</p>
      <div class="botoes lado">
        <button class="btn sec" id="b-backup" type="button">Fazer backup</button>
        <label class="btn sec" style="margin:0">Restaurar backup<input id="b-restaurar" type="file" accept=".json,application/json" hidden></label>
      </div>
    </div>
    <p class="rodape-info">${esc(uso)}<br>${EMPRESA.nome} · ${EMPRESA.resp} · ${EMPRESA.crea}</p>
    <a class="btn flutuante" href="#/obra/nova">+ Nova obra</a>`;

  $('#b-backup').onclick = fazerBackup;
  $('#b-restaurar').onchange = (e) => { const f = e.target.files[0]; if (f) restaurarBackup(f); e.target.value = ''; };
}

async function telaObra(main, id) {
  const nova = id === 'nova';
  const obra = nova ? { id: novoId(), nome: '', cliente: '', local: '', art: '', inicio: '' } : await pegar('obras', id);
  if (!obra) { location.hash = '#/'; return; }
  const visitas = nova ? [] : (await porIndice('visitas', 'obraId', obra.id)).sort(porData);
  const fotos = nova ? [] : await porIndice('fotos', 'obraId', obra.id);
  const numero = new Map(visitas.map((v, i) => [v.id, i + 1]));

  main.innerHTML = `
    <a class="voltar" href="#/">‹ Obras</a>
    <h1>${nova ? 'Nova obra' : esc(obra.nome)}</h1>
    ${nova ? '' : `<p class="sub">${esc([obra.cliente, obra.local].filter(Boolean).join(' · '))}</p>`}
    <details class="card" ${nova ? 'open' : ''}>
      <summary style="cursor:pointer;color:var(--titulo);font-weight:600">Dados da obra</summary>
      <form id="f-obra">
        <label for="o-nome">Nome da obra *</label>
        <input id="o-nome" name="nome" required value="${esc(obra.nome)}" placeholder="Ex.: Reforma apartamento Centro">
        <label for="o-cliente">Cliente</label>
        <input id="o-cliente" name="cliente" value="${esc(obra.cliente)}">
        <label for="o-local">Local (bairro e cidade)</label>
        <input id="o-local" name="local" value="${esc(obra.local)}" placeholder="Ex.: Uberaba, Curitiba/PR">
        <div class="duas">
          <div><label for="o-art">Nº da ART</label><input id="o-art" name="art" inputmode="numeric" value="${esc(obra.art)}"></div>
          <div><label for="o-inicio">Início</label><input id="o-inicio" name="inicio" type="date" value="${esc(obra.inicio)}"></div>
        </div>
        <div class="botoes"><button class="btn" type="submit">${nova ? 'Criar obra' : 'Salvar dados'}</button></div>
      </form>
    </details>
    ${nova ? '' : `
      <h2>Diário de obra</h2>
      ${visitas.length ? `<ul class="lista">${visitas.slice().reverse().map((v) => {
        const n = fotos.filter((f) => f.visitaId === v.id).length;
        const resumo = (v.atividades || v.orientacoes || '').split('\n')[0].slice(0, 90);
        return `<li><a class="item" href="#/visita/${v.id}">
          <strong>Visita nº ${numero.get(v.id)} · ${dataBR(v.data)}</strong>
          <small>${n} foto(s)${resumo ? ' · ' + esc(resumo) : ''}</small></a></li>`;
      }).join('')}</ul>` : '<p class="vazio">Nenhuma visita registrada.</p>'}
      <div class="botoes"><button class="btn perigo" id="b-excluir-obra" type="button">Excluir obra</button></div>
      <button class="btn flutuante" id="b-nova-visita" type="button">+ Nova visita (hoje)</button>`}`;

  $('#f-obra').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    Object.assign(obra, d, { atualizadoEm: agora() });
    if (!obra.criadoEm) obra.criadoEm = agora();
    await gravar('obras', obra);
    pedirArmazenamentoFixo();
    if (nova) location.hash = '#/obra/' + obra.id; else { aviso('Dados da obra salvos'); rota(); }
  };
  if (nova) return;

  $('#b-nova-visita').onclick = async () => {
    const v = { id: novoId(), obraId: obra.id, data: hoje(), climaManha: '', climaTarde: '', condicao: '', equipe: '', atividades: '', ocorrencias: '', orientacoes: '', criadoEm: agora(), atualizadoEm: agora() };
    await gravar('visitas', v);
    obra.atualizadoEm = agora(); await gravar('obras', obra);
    location.hash = '#/visita/' + v.id;
  };
  $('#b-excluir-obra').onclick = async () => {
    if (!confirm(`Excluir a obra "${obra.nome}" com ${visitas.length} visita(s) e ${fotos.length} foto(s)? Isso não tem volta (a não ser por um backup).`)) return;
    for (const f of fotos) await apagar('fotos', f.id);
    for (const v of visitas) await apagar('visitas', v.id);
    await apagar('obras', obra.id);
    aviso('Obra excluída'); location.hash = '#/';
  };
}

async function telaVisita(main, id) {
  const v = await pegar('visitas', id);
  if (!v) { location.hash = '#/'; return; }
  const obra = await pegar('obras', v.obraId);
  const campo = (nome, titulo, dica) => `
    <label for="v-${nome}">${titulo}</label>
    <textarea id="v-${nome}" name="${nome}" placeholder="${esc(dica)}">${esc(v[nome])}</textarea>`;

  main.innerHTML = `
    <a class="voltar" href="#/obra/${obra.id}">‹ ${esc(obra.nome)}</a>
    <h1>Visita · ${dataBR(v.data)}</h1>
    <form id="f-visita" class="card" autocomplete="off">
      <label for="v-data">Data da visita</label>
      <input id="v-data" name="data" type="date" value="${esc(v.data)}">
      <div class="duas">
        <div><label for="v-climaManha">Clima (manhã)</label><select id="v-climaManha" name="climaManha">${opcoes(CLIMAS, v.climaManha)}</select></div>
        <div><label for="v-climaTarde">Clima (tarde)</label><select id="v-climaTarde" name="climaTarde">${opcoes(CLIMAS, v.climaTarde)}</select></div>
      </div>
      <label for="v-condicao">Condição do canteiro</label>
      <select id="v-condicao" name="condicao">${opcoes(CONDICOES, v.condicao)}</select>
      ${campo('equipe', 'Equipe presente', 'Ex.: mestre João, 2 pedreiros, 1 servente')}
      ${campo('atividades', 'Atividades em execução', 'O que está sendo feito hoje')}
      ${campo('ocorrencias', 'Ocorrências', 'Problemas, atrasos, falta de material, chuva...')}
      ${campo('orientacoes', 'Orientações registradas', 'Orientações técnicas passadas à equipe nesta visita')}
      <p class="salvo" id="salvo"></p>
    </form>

    <h2>Fotos</h2>
    <div class="fotos" id="fotos"></div>

    <div class="botoes lado">
      <button class="btn zap" id="b-enviar" type="button">Gerar PDF e enviar</button>
      <button class="btn sec" id="b-baixar" type="button">Baixar PDF</button>
    </div>
    <div class="botoes"><button class="btn perigo" id="b-excluir-visita" type="button">Excluir visita</button></div>`;

  // Salvamento automático enquanto digita
  const form = $('#f-visita');
  let timer;
  const salvarAgora = async () => {
    clearTimeout(timer); _salvarPendente = null;
    Object.assign(v, Object.fromEntries(new FormData(form)), { atualizadoEm: agora() });
    await gravar('visitas', v);
    obra.atualizadoEm = v.atualizadoEm; await gravar('obras', obra);
    const s = $('#salvo'); if (s) s.textContent = 'Salvo no aparelho ✓ ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  const agendar = () => { clearTimeout(timer); _salvarPendente = salvarAgora; timer = setTimeout(salvarAgora, 700); };
  form.addEventListener('input', agendar);
  form.addEventListener('change', agendar);
  $('#v-data').addEventListener('change', () => { $('h1').textContent = 'Visita · ' + dataBR($('#v-data').value); });

  await mostrarFotos(v, obra);

  const gerar = async (modo, botao) => {
    if (_salvarPendente) await _salvarPendente();
    const textoOriginal = botao.textContent;
    botao.disabled = true; botao.textContent = 'Gerando PDF...';
    try {
      const { blob, nome } = await gerarPdf(v.id);
      if (modo === 'baixar') { baixar(blob, nome); aviso('PDF baixado'); return; }
      const r = await compartilharOuBaixar(blob, nome, 'application/pdf', 'Relatório de visita');
      if (r === 'baixado') aviso('PDF baixado (este aparelho não abriu o Compartilhar)');
      if (r === 'precisa-toque') {
        // O celular só deixa abrir o Compartilhar logo após um toque: o PDF já está pronto, falta um toque.
        botao.disabled = false; botao.textContent = 'PDF pronto: toque para enviar';
        botao.onclick = async () => { await compartilharOuBaixar(blob, nome, 'application/pdf', 'Relatório de visita'); botao.textContent = textoOriginal; botao.onclick = () => gerar('enviar', botao); };
        return;
      }
    } catch (e) {
      console.error(e); aviso('Não foi possível gerar o PDF: ' + e.message, 5000);
    }
    botao.disabled = false; botao.textContent = textoOriginal;
  };
  $('#b-enviar').onclick = (e) => gerar('enviar', e.currentTarget);
  $('#b-baixar').onclick = (e) => gerar('baixar', e.currentTarget);

  $('#b-excluir-visita').onclick = async () => {
    const fotos = await porIndice('fotos', 'visitaId', v.id);
    if (!confirm(`Excluir a visita de ${dataBR(v.data)} e ${fotos.length} foto(s)? Isso não tem volta (a não ser por um backup).`)) return;
    clearTimeout(timer); _salvarPendente = null;
    for (const f of fotos) await apagar('fotos', f.id);
    await apagar('visitas', v.id);
    aviso('Visita excluída'); location.hash = '#/obra/' + obra.id;
  };
}

async function mostrarFotos(v, obra) {
  limparUrls();
  const fotos = (await porIndice('fotos', 'visitaId', v.id)).sort((a, b) => a.ordem - b.ordem);
  const box = $('#fotos'); if (!box) return;
  box.innerHTML = fotos.map((f, i) => {
    const url = URL.createObjectURL(f.blob); _urls.push(url);
    return `<div class="foto">
      <img src="${url}" alt="Foto ${i + 1}" loading="lazy">
      <input data-legenda="${f.id}" value="${esc(f.legenda)}" placeholder="Legenda da foto ${i + 1}" aria-label="Legenda da foto ${i + 1}">
      <button type="button" data-remover="${f.id}">Remover</button>
    </div>`;
  }).join('') + `
    <label class="add-foto">+ Adicionar fotos<br><small style="font-weight:400">câmera ou galeria</small>
      <input id="i-fotos" type="file" accept="image/*" multiple>
    </label>`;

  $('#i-fotos').onchange = async (e) => {
    const arquivos = [...e.target.files]; e.target.value = '';
    if (!arquivos.length) return;
    let ok = 0;
    for (const [i, arq] of arquivos.entries()) {
      aviso(`Preparando foto ${i + 1} de ${arquivos.length}...`, 60000);
      try {
        const p = await processarFoto(arq);
        await gravar('fotos', { id: novoId(), visitaId: v.id, obraId: obra.id, ordem: Date.now() + i, legenda: '', criadoEm: agora(), atualizadoEm: agora(), ...p });
        ok++;
      } catch (erro) { console.error(erro); aviso(`Foto ${arq.name} não pôde ser lida`, 4000); }
    }
    pedirArmazenamentoFixo();
    if (ok) aviso(`${ok} foto(s) salva(s) no aparelho`);
    mostrarFotos(v, obra);
  };

  const timers = {};
  box.querySelectorAll('[data-legenda]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.legenda;
      const salvar = async () => {
        clearTimeout(timers[id]); if (_salvarPendente === salvar) _salvarPendente = null;
        const f = await pegar('fotos', id); if (!f) return;
        f.legenda = inp.value; f.atualizadoEm = agora(); await gravar('fotos', f);
      };
      clearTimeout(timers[id]); timers[id] = setTimeout(salvar, 600); _salvarPendente = salvar;
    });
  });
  box.querySelectorAll('[data-remover]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remover esta foto?')) return;
      await apagar('fotos', b.dataset.remover); mostrarFotos(v, obra);
    };
  });
}

// ---------------------------------------------------------------- PDF
let _logo;
async function logoDataUrl() {
  if (!_logo) _logo = await blobParaDataUrl(await (await fetch('img/logo-vm-clara.png')).blob());
  return _logo;
}

async function gerarPdf(visitaId) {
  if (!window.jspdf) throw new Error('o gerador de PDF ainda não carregou. Abra o app uma vez com internet.');
  const v = await pegar('visitas', visitaId);
  const obra = await pegar('obras', v.obraId);
  const visitas = (await porIndice('visitas', 'obraId', obra.id)).sort(porData);
  const num = visitas.findIndex((x) => x.id === v.id) + 1;
  const fotos = (await porIndice('fotos', 'visitaId', v.id)).sort((a, b) => a.ordem - b.ordem);
  const logo = await logoDataUrl();

  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210, H = 297, M = 15, LARG = W - 2 * M, FIM = H - 20;
  const NAVY = [11, 31, 51], AZUL = [59, 158, 255], TEXTO = [40, 52, 66], CINZA = [110, 124, 140];
  let y = 0;

  const cabecalho = () => {
    doc.setFillColor(...NAVY); doc.rect(0, 0, W, 30, 'F');
    doc.addImage(logo, 'PNG', M, 6, 17.4, 18, 'logo', 'FAST');
    doc.setTextColor(241, 245, 249); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('RELATÓRIO DE VISITA TÉCNICA', M + 23, 13.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(184, 199, 214);
    doc.text(`Diário de obra nº ${num}  ·  ${dataBR(v.data)}`, M + 23, 19.5);
    doc.text(`${EMPRESA.nome}  ·  ${EMPRESA.resp}  ·  ${EMPRESA.crea}`, M + 23, 24.5);
    y = 39;
  };
  const cabe = (h) => { if (y + h > FIM) { doc.addPage(); cabecalho(); } };
  const titulo = (t) => {
    cabe(16);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...NAVY);
    doc.text(t.toUpperCase(), M, y);
    doc.setDrawColor(...AZUL); doc.setLineWidth(0.6); doc.line(M, y + 1.8, M + 18, y + 1.8);
    y += 8;
  };
  const paragrafo = (txt, vazio = 'Sem registro.') => {
    const t = (txt || '').trim();
    doc.setFont('helvetica', t ? 'normal' : 'italic'); doc.setFontSize(10.5); doc.setTextColor(...(t ? TEXTO : CINZA));
    for (const linha of doc.splitTextToSize(t || vazio, LARG)) { cabe(5.2); doc.text(linha, M, y); y += 5.2; }
    y += 4;
  };

  cabecalho();

  // Quadro com os dados da obra e da visita
  const clima = [v.climaManha && `manhã: ${v.climaManha}`, v.climaTarde && `tarde: ${v.climaTarde}`].filter(Boolean).join('  ·  ');
  const linhas = [
    ['Obra', obra.nome], ['Cliente', obra.cliente], ['Local', obra.local], ['ART nº', obra.art],
    ['Data da visita', dataBR(v.data)], ['Clima', clima], ['Condição do canteiro', v.condicao]
  ].filter(([, val]) => val);
  const alturaQuadro = linhas.length * 6 + 5;
  doc.setFillColor(241, 245, 249); doc.setDrawColor(214, 222, 230); doc.setLineWidth(0.2);
  doc.roundedRect(M, y - 5, LARG, alturaQuadro, 2, 2, 'FD');
  doc.setFontSize(10);
  for (const [rot, val] of linhas) {
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...CINZA); doc.text(rot, M + 4, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...TEXTO); doc.text(doc.splitTextToSize(String(val), LARG - 50)[0], M + 45, y);
    y += 6;
  }
  y += 8;

  titulo('Equipe presente'); paragrafo(v.equipe);
  titulo('Atividades em execução'); paragrafo(v.atividades);
  titulo('Ocorrências'); paragrafo(v.ocorrencias);
  titulo('Orientações registradas'); paragrafo(v.orientacoes, 'Nenhuma orientação registrada nesta visita.');

  // Relatório fotográfico: 2 fotos por linha
  if (fotos.length) {
    titulo(`Relatório fotográfico (${fotos.length} foto${fotos.length > 1 ? 's' : ''})`);
    const GAP = 6, COL = (LARG - GAP) / 2, MAXH = 68;
    for (let i = 0; i < fotos.length; i += 2) {
      const par = fotos.slice(i, i + 2).map((f, k) => {
        const h = Math.min(MAXH, COL * f.altura / f.largura);
        const w = h * f.largura / f.altura;
        doc.setFontSize(9);
        const leg = doc.splitTextToSize(`Foto ${i + k + 1}${f.legenda ? ' - ' + f.legenda.trim() : ''}`, COL);
        return { f, w, h, leg };
      });
      const alturaLinha = MAXH + Math.max(...par.map((p) => p.leg.length)) * 4.2 + 7;
      cabe(alturaLinha);
      for (const [k, p] of par.entries()) {
        const x0 = M + k * (COL + GAP);
        doc.setFillColor(241, 245, 249); doc.rect(x0, y, COL, MAXH, 'F');
        doc.addImage(await blobParaDataUrl(p.f.blob), 'JPEG', x0 + (COL - p.w) / 2, y + (MAXH - p.h) / 2, p.w, p.h, p.f.id, 'FAST');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...TEXTO);
        doc.text(p.leg, x0, y + MAXH + 4.5);
      }
      y += alturaLinha;
    }
  }

  // Assinatura
  cabe(38); y += 10;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...TEXTO);
  doc.text(`Curitiba, ${dataExtenso(v.data)}.`, M, y); y += 20;
  doc.setDrawColor(...CINZA); doc.setLineWidth(0.3); doc.line(M, y, M + 80, y); y += 5;
  doc.setFont('helvetica', 'bold'); doc.text(EMPRESA.resp, M, y); y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...CINZA);
  doc.text(`Engenheiro Civil  ·  ${EMPRESA.crea}`, M, y);

  // Rodapé em todas as páginas
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setDrawColor(214, 222, 230); doc.setLineWidth(0.2); doc.line(M, H - 13, W - M, H - 13);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...CINZA);
    doc.text(`${EMPRESA.nome}  ·  CNPJ ${EMPRESA.cnpj}  ·  ${EMPRESA.cidade}`, M, H - 8.5);
    doc.text(`Página ${p} de ${total}`, W - M, H - 8.5, { align: 'right' });
  }

  return { blob: doc.output('blob'), nome: `Relatorio-visita-${num}-${slug(obra.nome)}-${v.data}.pdf` };
}

// ---------------------------------------------------------------- backup
async function fazerBackup() {
  const b = $('#b-backup'); b.disabled = true; b.textContent = 'Preparando...';
  try {
    const [obras, visitas, fotos] = await Promise.all([todos('obras'), todos('visitas'), todos('fotos')]);
    const fotosJson = [];
    for (const f of fotos) { const { blob, ...resto } = f; fotosJson.push({ ...resto, dados: await blobParaDataUrl(blob) }); }
    const json = JSON.stringify({ app: 'obras-vm', versao: 1, exportadoEm: agora(), obras, visitas, fotos: fotosJson });
    const nome = `backup-obras-vm-${hoje()}.json`;
    const r = await compartilharOuBaixar(new Blob([json], { type: 'application/json' }), nome, 'application/json', 'Backup Obras V&M');
    if (r === 'baixado') aviso('Backup baixado. Salve o arquivo no Nextcloud.', 4000);
    if (r === 'precisa-toque') { baixar(new Blob([json], { type: 'application/json' }), nome); aviso('Backup baixado. Salve o arquivo no Nextcloud.', 4000); }
  } catch (e) { console.error(e); aviso('Erro no backup: ' + e.message, 5000); }
  b.disabled = false; b.textContent = 'Fazer backup';
}

async function restaurarBackup(arquivo) {
  let dados;
  try { dados = JSON.parse(await arquivo.text()); } catch (e) { aviso('Arquivo inválido', 4000); return; }
  if (!dados || dados.app !== 'obras-vm') { aviso('Este arquivo não é um backup do Obras V&M', 4000); return; }
  if (!confirm(`Restaurar backup de ${new Date(dados.exportadoEm).toLocaleString('pt-BR')}?\n${dados.obras.length} obra(s), ${dados.visitas.length} visita(s), ${dados.fotos.length} foto(s).\n\nO backup é juntado ao que já existe aqui; quando o mesmo registro existe nos dois, fica a versão mais recente.`)) return;
  const juntar = async (loja, item) => {
    const atual = await pegar(loja, item.id);
    if (!atual || (item.atualizadoEm || '') >= (atual.atualizadoEm || '')) { await gravar(loja, item); return 1; }
    return 0;
  };
  let n = 0;
  for (const o of dados.obras) n += await juntar('obras', o);
  for (const v of dados.visitas) n += await juntar('visitas', v);
  for (const f of dados.fotos) {
    const { dados: d, ...resto } = f;
    n += await juntar('fotos', { ...resto, blob: await (await fetch(d)).blob() });
  }
  pedirArmazenamentoFixo();
  aviso(`Backup restaurado (${n} registro(s) atualizados)`, 4000);
  rota();
}

// ---------------------------------------------------------------- início
function mostrarRede() {
  const el = $('#status-rede');
  el.textContent = navigator.onLine ? 'online' : 'sem internet · salvando no aparelho';
  el.classList.toggle('off', !navigator.onLine);
}
window.addEventListener('online', mostrarRede);
window.addEventListener('offline', mostrarRede);
window.addEventListener('hashchange', rota);
document.addEventListener('visibilitychange', () => { if (document.hidden && _salvarPendente) _salvarPendente(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(console.error);
mostrarRede();
rota();
