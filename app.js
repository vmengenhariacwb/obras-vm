'use strict';
// Obras V&M: diário de obra com fotos e relatório de acompanhamento em PDF.
// Todos os dados ficam SOMENTE neste aparelho (IndexedDB). Nada é enviado para servidor.

// Número da versão mostrado no rodapé. Ao publicar, subir junto com VERSAO no sw.js (obras-vm-v15 = 15).
const VERSAO_APP = 23;

const EMPRESA = {
  nome: 'V&M Engenharia',
  cnpj: '46.301.194/0001-66',
  resp: 'Eng. Vinicius Melin',
  crea: 'CREA PR-184877/D',
  cidade: 'Curitiba/PR'
};
const CLIMAS = ['', 'Ensolarado', 'Parcialmente nublado', 'Nublado', 'Garoa', 'Chuvoso'];
const CONDICOES = ['', 'Praticável', 'Parcialmente praticável', 'Impraticável'];
// Financeiro: mesmas listas da planilha "CONTAS A PAGAR E RECEBER OBRAS" + Equipamentos/locação
const CLASSIFICACOES = ['Mão de obra', 'Material', 'Fornecedor', 'Equipamentos/locação', 'Prestação de serviços', 'Impostos', 'Contas', 'Reembolsos'];
const FORMAS = ['', 'Pix', 'Dinheiro', 'Boleto', 'Transferência', 'Cartão de crédito', 'Cartão de débito', 'Cheque'];
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ---------------------------------------------------------------- banco
let _db;
function abrirBanco() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, erro) => {
    const r = indexedDB.open('obras-vm', 5);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore('obras', { keyPath: 'id' });
        db.createObjectStore('visitas', { keyPath: 'id' }).createIndex('obraId', 'obraId');
        const f = db.createObjectStore('fotos', { keyPath: 'id' });
        f.createIndex('visitaId', 'visitaId');
        f.createIndex('obraId', 'obraId');
      }
      if (ev.oldVersion < 2) {
        // Versão 2: financeiro (lançamentos), comprovantes (fotos com lancamentoId) e registro de exclusões
        db.createObjectStore('lancamentos', { keyPath: 'id' }).createIndex('obraId', 'obraId');
        r.transaction.objectStore('fotos').createIndex('lancamentoId', 'lancamentoId');
        db.createObjectStore('excluidos', { keyPath: 'id' });
      }
      if (ev.oldVersion < 3) {
        // Versão 3: orçamentos (vistoria técnica + itens). Fotos da vistoria usam visitaId = id do orçamento.
        db.createObjectStore('orcamentos', { keyPath: 'id' });
      }
      if (ev.oldVersion < 4) {
        // Versão 4: modelos de orçamento (itens + porcentagem de cada um, para repartir o valor global)
        db.createObjectStore('modelos', { keyPath: 'id' });
      }
      if (ev.oldVersion < 5) {
        // Versão 5: ajustes que sincronizam (ex.: tabela de preços que a IA usa). A chave da IA NÃO fica aqui.
        db.createObjectStore('ajustes', { keyPath: 'id' });
      }
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
// Toda gravação/exclusão feita pelo usuário agenda uma sincronização com o Drive (ver aoMudar).
const gravar = (l, o) => tx(l, 'readwrite', (s) => s.put(o)).then((r) => { aoMudar(); return r; });
const apagar = (l, id) => tx(l, 'readwrite', (s) => s.delete(id)).then((r) => { aoMudar(); return r; });
const todos = (l) => tx(l, 'readonly', (s) => s.getAll());
const porIndice = (l, i, v) => tx(l, 'readonly', (s) => s.index(i).getAll(v));
// Exclusão feita pelo usuário: apaga e anota, para a sincronização saber que foi excluído.
async function excluir(l, id) { await apagar(l, id); await gravar('excluidos', { id, loja: l, em: agora() }); }

// ---------------------------------------------------------------- utilidades
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const agora = () => new Date().toISOString();
function hoje() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function maisDias(n) { const d = new Date(Date.now() + n * 864e5); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function dataBR(iso) { if (!iso) return ''; const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; }
function dataExtenso(iso) { const [a, m, d] = iso.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${a}`; }
const porData = (a, b) => (a.data || '').localeCompare(b.data || '') || (a.criadoEm || '').localeCompare(b.criadoEm || '');
function slug(s) { return String(s || 'obra').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'obra'; }
const moeda = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Entende "1.500,00", "1500", "1500,5" e "1.500" (milhar) como reais.
function lerValor(s) {
  s = String(s ?? '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
const valorCampo = (n) => (n ? Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
// Mesmos status da planilha: Pago, Em dia, Atrasado
const statusDe = (l) => (l.pago ? 'Pago' : (l.vencimento && l.vencimento < hoje() ? 'Atrasado' : 'Em dia'));
// Obras antigas (sem o campo) contam como "Em andamento".
const situacaoDe = (o) => (o && o.situacao === 'Concluída' ? 'Concluída' : 'Em andamento');
function somarMeses(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const ult = new Date(a, m - 1 + n + 1, 0).getDate();            // último dia do mês de destino
  const dt = new Date(a, m - 1 + n, Math.min(d, ult));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
const _scripts = {};
function carregarScript(url) {
  if (!_scripts[url]) _scripts[url] = new Promise((ok, erro) => {
    const s = document.createElement('script'); s.src = url; s.onload = ok;
    s.onerror = () => { delete _scripts[url]; erro(new Error('sem internet para carregar o gerador de planilha. Tente de novo com sinal.')); };
    document.head.appendChild(s);
  });
  return _scripts[url];
}
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
  const [tela, id, extra] = location.hash.replace(/^#\/?/, '').split('/');
  const main = $('#tela');
  try {
    if (tela === 'obra') await telaObra(main, id, extra === 'financeiro' ? 'financeiro' : 'diario');
    else if (tela === 'visita') await telaVisita(main, id);
    else if (tela === 'lancamento') await telaLancamento(main, id);
    else if (tela === 'novo-lancamento') await telaLancamento(main, null, id, extra);
    else if (tela === 'orcamentos') await telaOrcamentos(main);
    else if (tela === 'orcamento') await telaOrcamento(main, id);
    else if (tela === 'modelos') await telaModelos(main);
    else if (tela === 'modelo') await telaModelo(main, id);
    else if (tela === 'ia') await telaIA(main);
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
  const andamento = obras.filter((o) => situacaoDe(o) !== 'Concluída');
  const concluidas = obras.filter((o) => situacaoDe(o) === 'Concluída');
  const listaObras = (lista) => `<ul class="lista">${lista.map((o) => `
      <li><a class="item" href="#/obra/${o.id}">
        <strong>${esc(o.nome)}</strong>
        <small>${esc([o.cliente, o.local].filter(Boolean).join(' · '))}${o.cliente || o.local ? ' · ' : ''}${qtd(o.id)} visita(s)</small>
      </a></li>`).join('')}</ul>`;
  const lancs = await todos('lancamentos');
  const orcs = await todos('orcamentos');
  const orcAbertos = orcs.filter((o) => !['Aprovado', 'Recusado'].includes(o.situacao)).length;
  const retornos = orcs.filter((o) => o.situacao === 'Enviado' && o.retornarEm && o.retornarEm <= hoje()).sort((a, b) => a.retornarEm.localeCompare(b.retornarEm));
  const emAberto = lancs.filter((l) => !l.pago && l.vencimento);
  const daqui7 = maisDias(7);
  const atrasados = emAberto.filter((l) => l.vencimento < hoje());
  const proximos = emAberto.filter((l) => l.vencimento >= hoje() && l.vencimento <= daqui7);
  const nomeObra = (id) => (obras.find((o) => o.id === id) || {}).nome || '';
  const linhaAlerta = (l) => `<li><a class="item" href="#/lancamento/${l.id}"><strong>${esc(l.descricao)} · ${moeda(l.valor)}</strong>
      <small>${l.tipo === 'Receber' ? 'A receber' : 'A pagar'} · ${esc(nomeObra(l.obraId))} · venc. ${dataBR(l.vencimento)}</small></a></li>`;
  let uso = '';
  try { const e = await navigator.storage.estimate(); uso = `Espaço usado no aparelho: ${(e.usage / 1048576).toFixed(1)} MB.`; } catch (e) { /* sem suporte */ }

  main.innerHTML = `
    <nav class="abas">
      <a href="#/" aria-current="page">Obras</a>
      <a href="#/orcamentos">Orçamentos${orcAbertos ? ` (${orcAbertos})` : ''}</a>
    </nav>
    <h1>Obras</h1>
    <p class="sub">Diário de obra, fotos e relatórios de acompanhamento.</p>
    ${retornos.length ? `<h2 class="alerta">Retornar ao cliente (${retornos.length})</h2><ul class="lista">${retornos.map((o) => `
      <li><a class="item" href="#/orcamento/${o.id}"><strong>${esc(o.servico || 'Orçamento sem título')}</strong>
        <small>${esc(o.cliente || '')} · orçamento enviado · retornar em ${dataBR(o.retornarEm)}</small></a></li>`).join('')}</ul>` : ''}
    ${!obras.length ? '<p class="vazio">Nenhuma obra ainda. Toque em <b>+ Nova obra</b> para começar.</p>' : `
      <h2>Em andamento (${andamento.length})</h2>
      ${andamento.length ? listaObras(andamento) : '<p class="vazio">Nenhuma obra em andamento.</p>'}
      ${concluidas.length ? `<details class="grupo"><summary>Concluídas (${concluidas.length})</summary>${listaObras(concluidas)}</details>` : ''}`}

    ${atrasados.length ? `<h2 class="alerta">Atrasados (${atrasados.length})</h2><ul class="lista">${atrasados.sort((a, b) => a.vencimento.localeCompare(b.vencimento)).map(linhaAlerta).join('')}</ul>` : ''}
    ${proximos.length ? `<h2>Vencem em até 7 dias (${proximos.length})</h2><ul class="lista">${proximos.sort((a, b) => a.vencimento.localeCompare(b.vencimento)).map(linhaAlerta).join('')}</ul>` : ''}

    <h2>Financeiro</h2>
    <div class="card">
      <p class="sub" style="margin:0">Planilha Excel com os lançamentos de todas as obras, nas mesmas colunas da aba LANÇAMENTOS.</p>
      <div class="botoes"><button class="btn sec" id="b-excel" type="button">Exportar planilha (todas as obras)</button></div>
    </div>

    <h2>Google Drive</h2>
    <div class="card" id="card-drive">
      ${driveConectado() ? `
        <p class="sub" style="margin:0">Sincronização ligada neste aparelho. As mudanças vão para uma pasta escondida do seu Drive e aparecem nos outros aparelhos conectados.</p>
        <p class="sub" style="margin:.5rem 0 0">Última sincronização: <b>${esc(ultimaSync())}</b></p>
        <div class="botoes lado">
          <button class="btn" id="b-sync" type="button">Sincronizar agora</button>
          <button class="btn sec" id="b-desconectar" type="button">Desligar neste aparelho</button>
        </div>` : `
        <p class="sub" style="margin:0">Ligue para que celular e computador tenham os mesmos dados. Use a mesma conta Google nos dois.</p>
        <div class="botoes"><button class="btn" id="b-conectar" type="button">Conectar ao Google Drive</button></div>`}
    </div>

    <h2>Cópia de segurança</h2>
    <div class="card">
      <p class="sub" style="margin:0">Cópia extra num arquivo, para guardar no Nextcloud de vez em quando.</p>
      <div class="botoes lado">
        <button class="btn sec" id="b-backup" type="button">Fazer backup</button>
        <label class="btn sec" style="margin:0">Restaurar backup<input id="b-restaurar" type="file" accept=".json,application/json" hidden></label>
      </div>
    </div>
    <p class="rodape-info">${esc(uso)}<br>${EMPRESA.nome} · ${EMPRESA.resp} · ${EMPRESA.crea}<br>Versão do app: ${VERSAO_APP}</p>
    <a class="btn flutuante" href="#/obra/nova">+ Nova obra</a>`;

  if (navigator.onLine) prepararGoogle().catch(() => {}); // deixa o login pronto para o toque
  if ($('#b-conectar')) $('#b-conectar').onclick = () => sincronizar(true);
  if ($('#b-sync')) $('#b-sync').onclick = () => sincronizar(true);
  if ($('#b-desconectar')) $('#b-desconectar').onclick = desconectarDrive;
  $('#b-excel').onclick = (e) => exportarExcel(null, e.currentTarget);
  $('#b-backup').onclick = fazerBackup;
  $('#b-restaurar').onchange = (e) => { const f = e.target.files[0]; if (f) restaurarBackup(f); e.target.value = ''; };
}

async function telaObra(main, id, aba) {
  const nova = id === 'nova';
  const obra = nova ? { id: novoId(), nome: '', cliente: '', local: '', art: '', inicio: '', valorContrato: 0, custoPrevisto: 0, situacao: 'Em andamento' } : await pegar('obras', id);
  if (!obra) { location.hash = '#/'; return; }
  const concluida = situacaoDe(obra) === 'Concluída';
  const visitas = nova ? [] : (await porIndice('visitas', 'obraId', obra.id)).sort(porData);
  const fotos = nova ? [] : await porIndice('fotos', 'obraId', obra.id);
  const numero = new Map(visitas.map((v, i) => [v.id, i + 1]));

  main.innerHTML = `
    <a class="voltar" href="#/">‹ Obras</a>
    <h1>${nova ? 'Nova obra' : esc(obra.nome)}</h1>
    ${nova ? '' : `<p class="sub"><em class="st st-${slug(situacaoDe(obra))}">${situacaoDe(obra)}</em> ${esc([obra.cliente, obra.local].filter(Boolean).join(' · '))}</p>`}
    <details class="card" ${nova ? 'open' : ''}>
      <summary style="cursor:pointer;color:var(--titulo);font-weight:600">Dados da obra</summary>
      <form id="f-obra">
        <label for="o-nome">Nome da obra *</label>
        <input id="o-nome" name="nome" required value="${esc(obra.nome)}" placeholder="Ex.: Reforma apartamento Centro">
        <label for="o-cliente">Cliente</label>
        <input id="o-cliente" name="cliente" value="${esc(obra.cliente)}">
        <label for="o-local">Local (bairro e cidade)</label>
        <input id="o-local" name="local" value="${esc(obra.local)}" placeholder="Ex.: Uberaba, Curitiba/PR">
        <label for="o-inicio">Início</label><input id="o-inicio" name="inicio" type="date" value="${esc(obra.inicio)}">
        <div id="box-art" ${(obra.art || '').trim() ? '' : 'hidden'}>
          <label for="o-art">Nº da ART</label><input id="o-art" name="art" inputmode="numeric" value="${esc(obra.art)}" placeholder="Em branco = não aparece nos relatórios">
        </div>
        ${(obra.art || '').trim() ? '' : '<p style="margin:.4rem 0 0"><a href="#" id="l-art">+ Informar ART (se o serviço tiver)</a></p>'}
        <div class="duas">
          <div><label for="o-contrato">Valor do contrato (R$)</label><input id="o-contrato" name="valorContrato" inputmode="decimal" value="${valorCampo(obra.valorContrato)}" placeholder="0,00"></div>
          <div><label for="o-previsto">Custo previsto (R$)</label><input id="o-previsto" name="custoPrevisto" inputmode="decimal" value="${valorCampo(obra.custoPrevisto)}" placeholder="0,00"></div>
        </div>
        <label>Situação</label>
        <div class="segmento" role="radiogroup" aria-label="Situação">
          <label><input type="radio" name="situacao" value="Em andamento" ${concluida ? '' : 'checked'}><span>Em andamento</span></label>
          <label><input type="radio" name="situacao" value="Concluída" ${concluida ? 'checked' : ''}><span>Concluída</span></label>
        </div>
        <div class="botoes"><button class="btn" type="submit">${nova ? 'Criar obra' : 'Salvar dados'}</button></div>
      </form>
    </details>
    ${nova ? '' : `
      <nav class="abas">
        <a href="#/obra/${obra.id}" ${aba === 'diario' ? 'aria-current="page"' : ''}>Diário</a>
        <a href="#/obra/${obra.id}/financeiro" ${aba === 'financeiro' ? 'aria-current="page"' : ''}>Financeiro</a>
      </nav>
      <div id="conteudo-aba"></div>`}`;

  $('#f-obra').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.valorContrato = lerValor(d.valorContrato); d.custoPrevisto = lerValor(d.custoPrevisto);
    Object.assign(obra, d, { atualizadoEm: agora() });
    if (!obra.criadoEm) obra.criadoEm = agora();
    await gravar('obras', obra);
    pedirArmazenamentoFixo();
    if (nova) location.hash = '#/obra/' + obra.id; else { aviso('Dados da obra salvos'); rota(); }
  };
  if ($('#l-art')) $('#l-art').onclick = (e) => { e.preventDefault(); $('#box-art').hidden = false; e.target.parentNode.remove(); $('#o-art').focus(); };
  if (nova) return;

  const excluirObra = async () => {
    const lancs = await porIndice('lancamentos', 'obraId', obra.id);
    const todasFotos = await porIndice('fotos', 'obraId', obra.id);
    if (!confirm(`Excluir a obra "${obra.nome}" com ${visitas.length} visita(s), ${todasFotos.length} foto(s) e ${lancs.length} lançamento(s)? Isso não tem volta (a não ser por um backup).`)) return;
    for (const f of todasFotos) await excluir('fotos', f.id);
    for (const l of lancs) await excluir('lancamentos', l.id);
    for (const v of visitas) await excluir('visitas', v.id);
    await excluir('obras', obra.id);
    aviso('Obra excluída'); location.hash = '#/';
  };

  if (aba === 'financeiro') { await abaFinanceiro($('#conteudo-aba'), obra, excluirObra); return; }

  $('#conteudo-aba').innerHTML = `
      <h2>Diário de obra</h2>
      ${visitas.length ? `<ul class="lista">${visitas.slice().reverse().map((v) => {
        const n = fotos.filter((f) => f.visitaId === v.id).length;
        const resumo = (v.atividades || v.orientacoes || '').split('\n')[0].slice(0, 90);
        return `<li><a class="item" href="#/visita/${v.id}">
          <strong>Visita nº ${numero.get(v.id)} · ${dataBR(v.data)}</strong>
          <small>${n} foto(s)${resumo ? ' · ' + esc(resumo) : ''}</small></a></li>`;
      }).join('')}</ul>` : '<p class="vazio">Nenhuma visita registrada.</p>'}
      ${visitas.length ? `
      <details class="card" style="margin-top:1rem">
        <summary style="cursor:pointer;color:var(--titulo);font-weight:600">Relatório consolidado (PDF para o cliente)</summary>
        <p class="sub" style="margin:.6rem 0 0">Junta as visitas do período num PDF só, com atividades, orientações e fotos. Não inclui nada do financeiro.</p>
        <div class="duas">
          <div><label for="r-de">De</label><input id="r-de" type="date" value="${esc(visitas[0].data)}"></div>
          <div><label for="r-ate">Até</label><input id="r-ate" type="date" value="${esc(visitas[visitas.length - 1].data > hoje() ? visitas[visitas.length - 1].data : hoje())}"></div>
        </div>
        <div class="botoes lado">
          <button class="btn zap" id="b-rel-enviar" type="button">Gerar e enviar</button>
          <button class="btn sec" id="b-rel-baixar" type="button">Baixar PDF</button>
        </div>
      </details>` : ''}
      <div class="botoes"><button class="btn perigo" id="b-excluir-obra" type="button">Excluir obra</button></div>
      <button class="btn flutuante" id="b-nova-visita" type="button">+ Nova visita (hoje)</button>`;

  $('#b-nova-visita').onclick = async () => {
    const v = { id: novoId(), obraId: obra.id, data: hoje(), climaManha: '', climaTarde: '', condicao: '', equipe: '', atividades: '', ocorrencias: '', orientacoes: '', criadoEm: agora(), atualizadoEm: agora() };
    await gravar('visitas', v);
    obra.atualizadoEm = agora(); await gravar('obras', obra);
    location.hash = '#/visita/' + v.id;
  };
  $('#b-excluir-obra').onclick = excluirObra;
  if ($('#b-rel-enviar')) {
    const gerador = () => {
      const de = $('#r-de').value, ate = $('#r-ate').value;
      if (de && ate && de > ate) throw new Error('a data "De" está depois da data "Até"');
      return gerarRelatorioObra(obra.id, de, ate);
    };
    $('#b-rel-enviar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'enviar', 'Relatório de Acompanhamento de Obra');
    $('#b-rel-baixar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'baixar', 'Relatório de Acompanhamento de Obra');
  }
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
      <label for="v-relato">Relato da visita <small style="font-weight:400">(só para você; não vai no PDF)</small></label>
      <textarea id="v-relato" name="relato" style="min-height:140px" placeholder="Escreva ou dite (microfone do teclado) o que aconteceu, do seu jeito. Depois toque em Preencher com IA.">${esc(v.relato)}</textarea>
      <div class="botoes" style="margin-top:.5rem"><button class="btn sec" id="b-ia-visita" type="button">✨ Preencher com IA</button></div>
      <div id="ia-visita-res"></div>
      <hr style="border:0;border-top:1px solid var(--borda, #24405e);margin:1rem 0 .4rem">
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
      ${campo('observacao', 'Observação', 'Ressalvas técnicas (opcional; em branco não aparece no PDF)')}
      <p class="salvo" id="salvo"></p>
    </form>

    <h2>Fotos</h2>
    <div id="acoes-fotos"></div>
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

  // IA: relato → campos (você revisa; nada vai ao PDF sem passar por esta tela)
  const MARCA_REVISAR = /\[\s*(confirmar|sugest[aã]o)[^\]]*\]/i;   // [confirmar], [confirmar data], [sugestão] ...
  const CAMPOS_IA = [['equipe', 'equipe_presente', 'Equipe presente'], ['atividades', 'atividades_em_execucao', 'Atividades em execução'],
    ['ocorrencias', 'ocorrencias', 'Ocorrências'], ['orientacoes', 'orientacoes_registradas', 'Orientações registradas'], ['observacao', 'observacao', 'Observação']];
  $('#b-ia-visita').onclick = async (e) => {
    const b = e.currentTarget;
    const relato = $('#v-relato').value.trim();
    if (relato.length < 15) { aviso('Escreva ou dite o relato da visita primeiro', 3500); $('#v-relato').focus(); return; }
    const cheios = CAMPOS_IA.filter(([c]) => $('#v-' + c).value.trim()).map(([, , t]) => t);
    if (cheios.length && !confirm(`Estes campos já estão preenchidos:\n- ${cheios.join('\n- ')}\n\nA IA vai substituir o texto deles. Continuar?`)) return;
    await salvarAgora();
    const todas = (await porIndice('visitas', 'obraId', obra.id)).filter((x) => x.id !== v.id && (x.data || '') <= (v.data || '')).sort(porData);
    const ant = todas[todas.length - 1];
    const anterior = ant && CAMPOS_IA.some(([c]) => (ant[c] || '').trim())
      ? { data: dataBR(ant.data), campos: Object.fromEntries(CAMPOS_IA.map(([c, k]) => [k, ant[c] || ''])) } : null;
    const orc = obra.orcamentoId ? await pegar('orcamentos', obra.orcamentoId) : null;
    const dadosObra = { obra: obra.nome, cliente: obra.cliente || '', local: obra.local || '', os: (orc && orc.numero) || '' };
    b.disabled = true; b.textContent = 'A IA está redigindo...'; $('#ia-visita-res').innerHTML = '';
    try {
      const { r, usd } = await preencherVisitaIA(relato, dadosObra, anterior);
      for (const [c, k] of CAMPOS_IA) $('#v-' + c).value = (r[k] || '').trim();
      await salvarAgora();
      const pend = CAMPOS_IA.filter(([c]) => MARCA_REVISAR.test($('#v-' + c).value)).map(([, , t]) => t);
      $('#ia-visita-res').innerHTML = `<p class="sub" style="margin:.5rem 0 0"><b>✓ Campos preenchidos pela IA.</b> Revise e ajuste antes de gerar o PDF.
        ${pend.length ? `<br>Tem <b>[confirmar]</b> ou <b>[sugestão]</b> em: ${esc(pend.join(', '))}. Complete ou apague essas marcas.` : ''}
        <br>Custo: ${textoGasto(usd)}</p>`;
      aviso('Campos preenchidos: revise', 3500);
    } catch (er) {
      aviso('Erro: ' + er.message, 7000);
      $('#ia-visita-res').innerHTML = `<p class="sub" style="margin:.5rem 0 0">Não deu para preencher: ${esc(er.message)}</p>`;
    }
    b.disabled = false; b.textContent = '✨ Preencher com IA';
  };

  // Antes do PDF: avisa se ficou [confirmar] ou [sugestão] nos campos ou nas legendas
  const conferirAntesDoPdf = () => {
    const marca = MARCA_REVISAR;
    const onde = CAMPOS_IA.filter(([c]) => marca.test($('#v-' + c).value)).map(([, , t]) => t);
    document.querySelectorAll('[data-legenda]').forEach((inp, i) => { if (marca.test(inp.value)) onde.push(`legenda da foto ${i + 1}`); });
    return !onde.length || confirm(`Ainda há [confirmar] ou [sugestão] em:\n- ${onde.join('\n- ')}\n\nEssas marcas iriam para o PDF do cliente. Gerar mesmo assim?`);
  };
  $('#b-enviar').onclick = (e) => { if (conferirAntesDoPdf()) acaoPdf(e.currentTarget, () => gerarPdf(v.id), 'enviar', 'Relatório de Acompanhamento de Obra'); };
  $('#b-baixar').onclick = (e) => { if (conferirAntesDoPdf()) acaoPdf(e.currentTarget, () => gerarPdf(v.id), 'baixar', 'Relatório de Acompanhamento de Obra'); };

  $('#b-excluir-visita').onclick = async () => {
    const fotos = await porIndice('fotos', 'visitaId', v.id);
    if (!confirm(`Excluir a visita de ${dataBR(v.data)} e ${fotos.length} foto(s)? Isso não tem volta (a não ser por um backup).`)) return;
    clearTimeout(timer); _salvarPendente = null;
    for (const f of fotos) await excluir('fotos', f.id);
    await excluir('visitas', v.id);
    aviso('Visita excluída'); location.hash = '#/obra/' + obra.id;
  };
}

async function mostrarFotos(v, obra) {
  limparUrls();
  const fotos = (await porIndice('fotos', 'visitaId', v.id)).sort((a, b) => a.ordem - b.ordem);
  const box = $('#fotos'); if (!box) return;
  const naVisita = !!$('#v-relato');
  box.innerHTML = fotos.map((f, i) => {
    const url = URL.createObjectURL(f.blob); _urls.push(url);
    return `<div class="foto">
      <img src="${url}" alt="Foto ${i + 1}" loading="lazy">
      ${naVisita ? `<textarea class="legenda" rows="2" data-legenda="${f.id}" placeholder="Legenda da foto ${i + 1}" aria-label="Legenda da foto ${i + 1}">${esc(f.legenda)}</textarea>` : `<input data-legenda="${f.id}" value="${esc(f.legenda)}" placeholder="Legenda da foto ${i + 1}" aria-label="Legenda da foto ${i + 1}">`}
      ${naVisita ? `<button type="button" data-ia-leg="${f.id}">✨ Gerar legenda com IA</button>` : ''}
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
  // Legendas pela IA: a foto (reduzida a 1024 px) + o relato e os campos da visita
  const contextoVisita = () => [['Relato', 'relato'], ['Atividades em execução', 'atividades'], ['Ocorrências', 'ocorrencias'], ['Orientações', 'orientacoes']]
    .map(([t, c]) => { const el = $('#v-' + c); const s = el ? el.value.trim() : (v[c] || '').trim(); return s ? `${t}:\n${s}` : ''; })
    .filter(Boolean).join('\n\n') || 'Sem texto na visita.';
  const gerarLegenda = async (id) => {
    const f = await pegar('fotos', id); if (!f) return 0;
    const { legenda, usd } = await legendaFotoIA(f.blob, contextoVisita());
    const inp = box.querySelector(`[data-legenda="${id}"]`); if (inp) inp.value = legenda;
    f.legenda = legenda; f.atualizadoEm = agora(); await gravar('fotos', f);
    return usd;
  };
  box.querySelectorAll('[data-ia-leg]').forEach((b) => {
    b.onclick = async () => {
      const inp = box.querySelector(`[data-legenda="${b.dataset.iaLeg}"]`);
      if (inp.value.trim() && !confirm('Esta foto já tem legenda. Substituir pela da IA?')) return;
      b.disabled = true; b.textContent = 'Gerando...';
      try { const usd = await gerarLegenda(b.dataset.iaLeg); aviso(`Legenda gerada (${textoGasto(usd)}): revise`, 3500); }
      catch (er) { aviso('Erro: ' + er.message, 7000); }
      b.disabled = false; b.textContent = '✨ Gerar legenda com IA';
    };
  });
  const acoes = $('#acoes-fotos');
  if (acoes) {
    acoes.innerHTML = fotos.length ? '<div class="botoes" style="margin:0 0 .8rem"><button class="btn sec" id="b-ia-legendas" type="button">✨ Gerar legendas de todas as fotos</button></div>' : '';
    if (fotos.length) $('#b-ia-legendas').onclick = async (e) => {
      const b = e.currentTarget;
      const vazias = fotos.filter((f) => !box.querySelector(`[data-legenda="${f.id}"]`).value.trim());
      let alvo = vazias;
      if (vazias.length < fotos.length) {
        const sub = confirm(`${fotos.length - vazias.length} foto(s) já têm legenda.\n\nOK = gerar para TODAS (substitui as que já existem)\nCancelar = só para as ${vazias.length} sem legenda`);
        alvo = sub ? fotos : vazias;
      }
      if (!alvo.length) { aviso('Todas as fotos já têm legenda', 3000); return; }
      b.disabled = true; let usd = 0, ok = 0;
      for (const [i, f] of alvo.entries()) {
        b.textContent = `Gerando legenda ${i + 1} de ${alvo.length}...`;
        try { usd += await gerarLegenda(f.id); ok++; } catch (er) { aviso('Erro: ' + er.message, 7000); if (/chave|crédito|internet|permissão/i.test(er.message)) break; }
      }
      b.disabled = false; b.textContent = '✨ Gerar legendas de todas as fotos';
      if (ok) aviso(`${ok} legenda(s) gerada(s) (${textoGasto(usd)}): revise`, 4000);
    };
  }

  box.querySelectorAll('[data-remover]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remover esta foto?')) return;
      await excluir('fotos', b.dataset.remover); mostrarFotos(v, obra);
    };
  });
}

// ---------------------------------------------------------------- financeiro
let _filtroFin = 'todos';
const ehComputador = () => !matchMedia('(pointer: coarse)').matches;

async function abaFinanceiro(box, obra, excluirObra) {
  const ls = (await porIndice('lancamentos', 'obraId', obra.id))
    .sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || '') || (a.criadoEm || '').localeCompare(b.criadoEm || ''));
  const soma = (f) => ls.filter(f).reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const aReceberTotal = soma((l) => l.tipo === 'Receber'), recebido = soma((l) => l.tipo === 'Receber' && l.pago);
  const custos = soma((l) => l.tipo === 'Pagar'), pago = soma((l) => l.tipo === 'Pagar' && l.pago);
  const contrato = Number(obra.valorContrato) || 0, previsto = Number(obra.custoPrevisto) || 0;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const barra = (p, alerta) => `<div class="barra" role="img" aria-label="${p}%"><span class="${alerta ? 'alerta' : ''}" style="width:${Math.min(100, p)}%"></span></div>`;
  const porClasse = CLASSIFICACOES.map((c) => [c, soma((l) => l.tipo === 'Pagar' && l.classificacao === c)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  // Categorias que aparecem nos lançamentos desta obra (na ordem da lista padrão; outras no fim).
  const usadas = new Set(ls.map((l) => l.classificacao || 'Sem classificação'));
  const catsObra = [...CLASSIFICACOES.filter((c) => usadas.has(c)), ...[...usadas].filter((c) => !CLASSIFICACOES.includes(c))];
  const filtros ={ todos: 'Todos', pagar: 'A pagar (em aberto)', receber: 'A receber (em aberto)', atrasados: 'Atrasados', pagos: 'Pagos / recebidos' };
  const passa = {
    todos: () => true, pagar: (l) => l.tipo === 'Pagar' && !l.pago, receber: (l) => l.tipo === 'Receber' && !l.pago,
    atrasados: (l) => statusDe(l) === 'Atrasado', pagos: (l) => l.pago
  };
  if (!passa[_filtroFin]) _filtroFin = 'todos';
  const lista = ls.filter(passa[_filtroFin]);
  const saldo = recebido - pago;

  box.innerHTML = `
    <div class="resumo">
      <div class="card">
        <small>Recebido</small>
        <strong>${moeda(recebido)}</strong>
        ${contrato ? `${barra(pct(recebido, contrato))}<small>${pct(recebido, contrato)}% do contrato (${moeda(contrato)})</small>` : '<small>Informe o valor do contrato em "Dados da obra"</small>'}
        ${contrato ? `<small>Falta receber do contrato: ${moeda(contrato - recebido)}</small>` : ''}
        ${aReceberTotal - recebido > 0 || !contrato ? `<small>Lançado a receber: ${moeda(aReceberTotal - recebido)}</small>` : ''}
      </div>
      <div class="card">
        <small>Custos (pagos + a pagar)</small>
        <strong>${moeda(custos)}</strong>
        ${previsto ? `${barra(pct(custos, previsto), custos > previsto)}<small${custos > previsto ? ' class="alerta"' : ''}>${pct(custos, previsto)}% do previsto (${moeda(previsto)})</small>` : '<small>Informe o custo previsto em "Dados da obra"</small>'}
        <small>Pago: ${moeda(pago)} · A pagar: ${moeda(custos - pago)}</small>
      </div>
      <div class="card">
        <small>Saldo em caixa da obra (recebido − pago)</small>
        <strong class="${saldo < 0 ? 'alerta' : 'positivo'}">${moeda(saldo)}</strong>
        ${contrato ? `<small>Resultado previsto (contrato − custos lançados): ${moeda(contrato - custos)}</small>` : ''}
      </div>
    </div>

    ${porClasse.length ? `<h2>Custos por classificação</h2>
    <div class="card classes">${porClasse.map(([c, v]) => `
      <div><span>${esc(c)}</span><b>${moeda(v)}</b>${barra(pct(v, custos))}</div>`).join('')}
    </div>` : ''}

    <h2>Lançamentos</h2>
    <label for="filtro-fin" class="sr">Mostrar</label>
    <select id="filtro-fin">${Object.entries(filtros).map(([k, t]) => `<option value="${k}"${k === _filtroFin ? ' selected' : ''}>${t}</option>`).join('')}</select>
    ${lista.length ? `<ul class="lista" style="margin-top:.6rem">${lista.map((l) => {
      const st = statusDe(l);
      return `<li><a class="item lanc" href="#/lancamento/${l.id}">
        <span><strong>${esc(l.descricao)}</strong>
          <small>${esc(l.classificacao)} · ${l.pago && l.dataPagamento ? 'pago ' + dataBR(l.dataPagamento) : (l.vencimento ? 'venc. ' + dataBR(l.vencimento) : 'sem vencimento')}${l.formaPagamento ? ' · ' + esc(l.formaPagamento) : ''}</small></span>
        <span class="valor"><b class="${l.tipo === 'Receber' ? 'positivo' : ''}">${l.tipo === 'Receber' ? '+' : '−'} ${moeda(l.valor)}</b>
          <em class="st st-${slug(st)}">${st}</em></span>
      </a></li>`;
    }).join('')}</ul>` : '<p class="vazio" style="margin-top:.6rem">Nenhum lançamento aqui.</p>'}

    <div class="botoes lado">
      <a class="btn sec" href="#/novo-lancamento/${obra.id}/Receber">+ Recebimento</a>
      <button class="btn sec" id="b-excel-obra" type="button">Exportar planilha</button>
    </div>
    ${ls.length ? `
    <details class="card" style="margin-top:1rem">
      <summary style="cursor:pointer;color:var(--titulo);font-weight:600">Relatório financeiro (PDF · uso interno)</summary>
      <p class="sub" style="margin:.6rem 0 0">Escolha as categorias que entram no relatório. Com todas marcadas, sai o relatório completo da obra.</p>
      <div class="cats">${catsObra.map((c) => `
        <label class="check"><input type="checkbox" class="cat-rel" value="${esc(c)}" checked> ${esc(c)}</label>`).join('')}
      </div>
      <div class="botoes lado">
        <button class="btn sec" id="b-cats-todas" type="button">Marcar todas</button>
        <button class="btn sec" id="b-cats-nenhuma" type="button">Desmarcar todas</button>
      </div>
      <div class="botoes"><button class="btn" id="b-rel-fin" type="button">Gerar relatório</button></div>
    </details>` : ''}
    <div class="botoes"><button class="btn perigo" id="b-excluir-obra" type="button">Excluir obra</button></div>
    <a class="btn flutuante" href="#/novo-lancamento/${obra.id}/Pagar">+ Nova despesa</a>`;

  $('#filtro-fin').onchange = (e) => { _filtroFin = e.target.value; abaFinanceiro(box, obra, excluirObra); };
  $('#b-excel-obra').onclick = (e) => exportarExcel(obra.id, e.currentTarget);
  if ($('#b-rel-fin')) {
    const marcar = (v) => document.querySelectorAll('.cat-rel').forEach((c) => { c.checked = v; });
    $('#b-cats-todas').onclick = () => marcar(true);
    $('#b-cats-nenhuma').onclick = () => marcar(false);
    $('#b-rel-fin').onclick = (e) => {
      const escolhidas = [...document.querySelectorAll('.cat-rel:checked')].map((c) => c.value);
      if (!escolhidas.length) { aviso('Marque pelo menos uma categoria'); return; }
      const filtro = escolhidas.length === catsObra.length ? null : escolhidas;
      acaoPdf(e.currentTarget, () => gerarRelatorioFinanceiro(obra.id, filtro), ehComputador() ? 'baixar' : 'enviar', 'Relatório financeiro');
    };
  }
  $('#b-excluir-obra').onclick = excluirObra;
}

async function telaLancamento(main, id, obraIdNovo, tipoNovo) {
  const novo = !id;
  const receber = tipoNovo === 'Receber';
  const l = novo
    ? { id: novoId(), obraId: obraIdNovo, tipo: receber ? 'Receber' : 'Pagar', descricao: '', classificacao: receber ? 'Prestação de serviços' : 'Material', valor: 0, vencimento: hoje(), pago: false, dataPagamento: '', formaPagamento: '', observacao: '' }
    : await pegar('lancamentos', id);
  if (!l) { location.hash = '#/'; return; }
  const obra = await pegar('obras', l.obraId);
  if (!obra) { location.hash = '#/'; return; }
  const anexos = novo ? [] : (await porIndice('fotos', 'lancamentoId', l.id)).sort((a, b) => a.ordem - b.ordem);
  const novosAnexos = [];
  const voltar = `#/obra/${obra.id}/financeiro`;

  main.innerHTML = `
    <a class="voltar" href="${voltar}">‹ ${esc(obra.nome)} · Financeiro</a>
    <h1>${novo ? (receber ? 'Novo recebimento' : 'Nova despesa') : 'Lançamento'}</h1>
    ${novo ? '' : `<p class="sub">Status: <em class="st st-${slug(statusDe(l))}">${statusDe(l)}</em></p>`}
    <form id="f-lanc" class="card" autocomplete="off">
      ${novo ? `<div id="box-nf" style="margin-bottom:1rem">
        <label class="add-foto" style="min-height:64px">📷 Ler nota fiscal com IA<input id="i-nf" type="file" accept="image/*"></label>
        <p class="sub" style="margin:.4rem 0 0">Tire a foto da nota (ou escolha da galeria). A IA preenche os campos e a foto fica guardada como comprovante. Confira antes de salvar.</p>
        <div id="nf-res"></div>
      </div>` : ''}
      <div class="segmento" role="radiogroup" aria-label="Tipo">
        <label><input type="radio" name="tipo" value="Pagar" ${l.tipo === 'Pagar' ? 'checked' : ''}><span>Pagar (saída)</span></label>
        <label><input type="radio" name="tipo" value="Receber" ${l.tipo === 'Receber' ? 'checked' : ''}><span>Receber (entrada)</span></label>
      </div>
      <label for="l-desc">Descrição *</label>
      <input id="l-desc" name="descricao" required value="${esc(l.descricao)}" placeholder="Ex.: Cimento e areia · Loja X">
      <label for="l-class">Classificação</label>
      <select id="l-class" name="classificacao">${opcoes(CLASSIFICACOES, l.classificacao)}</select>
      <div class="duas">
        <div><label for="l-valor" id="rot-valor">Valor (R$) *</label><input id="l-valor" name="valor" required inputmode="decimal" value="${valorCampo(l.valor)}" placeholder="0,00"></div>
        <div><label for="l-venc">Vencimento</label><input id="l-venc" name="vencimento" type="date" value="${esc(l.vencimento)}"></div>
      </div>
      <div class="duas">
        <div><label for="l-forma">Forma de pagamento</label><select id="l-forma" name="formaPagamento">${opcoes(FORMAS, l.formaPagamento)}</select></div>
        ${novo ? '<div><label for="l-parc">Parcelas</label><input id="l-parc" name="parcelas" type="number" min="1" max="60" value="1" inputmode="numeric"></div>' : '<div></div>'}
      </div>
      <p class="sub" id="dica-parc" hidden style="margin:.4rem 0 0">O valor é o <b>total</b>: ele é dividido nas parcelas, com vencimentos mês a mês.</p>
      <label class="check"><input type="checkbox" name="pago" id="l-pago" ${l.pago ? 'checked' : ''}> <span id="rot-pago">Já foi pago</span></label>
      <div id="box-datapag" ${l.pago ? '' : 'hidden'}>
        <label for="l-datapag">Data do pagamento</label>
        <input id="l-datapag" name="dataPagamento" type="date" value="${esc(l.dataPagamento || hoje())}">
      </div>
      <label for="l-obs">Observação</label>
      <textarea id="l-obs" name="observacao" style="min-height:70px">${esc(l.observacao)}</textarea>

      <label>Comprovantes / notas</label>
      <div class="fotos" id="anexos"></div>
      <div class="botoes"><button class="btn" type="submit">Salvar</button></div>
    </form>
    ${novo ? '' : '<div class="botoes"><button class="btn perigo" id="b-excluir-lanc" type="button">Excluir lançamento</button></div>'}`;

  const form = $('#f-lanc');
  const ajustarTextos = () => {
    const rec = form.tipo.value === 'Receber';
    $('#rot-pago').textContent = rec ? 'Já foi recebido' : 'Já foi pago';
    const n = parseInt(form.parcelas?.value, 10) || 1;
    $('#rot-valor').textContent = n > 1 ? 'Valor total (R$) *' : 'Valor (R$) *';
    $('#dica-parc').hidden = n <= 1;
    if ($('#box-nf')) $('#box-nf').hidden = rec;
  };
  form.addEventListener('change', ajustarTextos);
  form.addEventListener('input', ajustarTextos);
  ajustarTextos();
  $('#l-pago').onchange = (e) => { $('#box-datapag').hidden = !e.target.checked; ajustarTextos(); };
  $('#l-valor').onblur = (e) => { const v = lerValor(e.target.value); e.target.value = v ? valorCampo(v) : ''; };

  const desenharAnexos = () => {
    limparUrls();
    const itens = [...anexos.map((a) => ({ ...a, salvo: true })), ...novosAnexos.map((a, i) => ({ ...a, idx: i }))];
    $('#anexos').innerHTML = itens.map((a) => {
      const url = URL.createObjectURL(a.blob); _urls.push(url);
      return `<div class="foto"><img src="${url}" alt="Comprovante" data-ver="${url}">
        <button type="button" ${a.salvo ? `data-rem-salvo="${a.id}"` : `data-rem-novo="${a.idx}"`}>Remover</button></div>`;
    }).join('') + `<label class="add-foto">+ Foto do comprovante<input id="i-anexo" type="file" accept="image/*" multiple></label>`;
    $('#i-anexo').onchange = async (e) => {
      const arqs = [...e.target.files]; e.target.value = '';
      for (const arq of arqs) {
        try { aviso('Preparando foto...', 60000); novosAnexos.push(await processarFoto(arq)); } catch (er) { aviso('Foto não pôde ser lida', 4000); }
      }
      aviso(novo ? 'Foto anexada (salva ao tocar em Salvar)' : 'Foto anexada (toque em Salvar)');
      desenharAnexos();
    };
    $('#anexos').querySelectorAll('[data-ver]').forEach((img) => { img.onclick = () => verImagem(img.dataset.ver); });
    $('#anexos').querySelectorAll('[data-rem-novo]').forEach((b) => { b.onclick = () => { novosAnexos.splice(+b.dataset.remNovo, 1); desenharAnexos(); }; });
    $('#anexos').querySelectorAll('[data-rem-salvo]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Remover este comprovante?')) return;
        await excluir('fotos', b.dataset.remSalvo);
        anexos.splice(anexos.findIndex((a) => a.id === b.dataset.remSalvo), 1); desenharAnexos();
      };
    });
  };
  desenharAnexos();

  // Nota fiscal pela IA: a foto vira comprovante e a IA preenche os campos (você confere e salva).
  const dataBR = (s) => (s || '').split('-').reverse().join('/');
  const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const preencherNF = async (r, usd) => {
    if (!r.eh_nota) { $('#nf-res').innerHTML = '<p class="sub" style="color:var(--alerta,#f59e0b)">A IA achou que essa foto não é uma nota fiscal. A foto ficou anexada; preencha os campos à mão.</p>'; return; }
    form.tipo.value = 'Pagar';
    const desc = [r.descricao_curta, r.fornecedor].map((s) => (s || '').trim()).filter(Boolean).join(' · ');
    if (desc) $('#l-desc').value = desc;
    if (CLASSIFICACOES.includes(r.classificacao)) $('#l-class').value = r.classificacao;
    if (r.valor_total > 0) $('#l-valor').value = valorCampo(r.valor_total);
    const venc = dataOk(r.vencimento) ? r.vencimento : dataOk(r.data_emissao) ? r.data_emissao : '';
    if (venc) $('#l-venc').value = venc;
    if (r.forma_pagamento && FORMAS.includes(r.forma_pagamento)) $('#l-forma').value = r.forma_pagamento;
    if (['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito'].includes(r.forma_pagamento) && !dataOk(r.vencimento)) {
      $('#l-pago').checked = true; $('#box-datapag').hidden = false;
      $('#l-datapag').value = dataOk(r.data_emissao) ? r.data_emissao : hoje();
    }
    const linhas = [];
    const cab = [r.numero_nota ? `NF nº ${r.numero_nota}` : '', r.fornecedor, r.cnpj_fornecedor ? `CNPJ/CPF ${r.cnpj_fornecedor}` : ''].filter(Boolean).join(' · ');
    if (cab) linhas.push(cab);
    if (dataOk(r.data_emissao)) linhas.push(`Emissão: ${dataBR(r.data_emissao)}`);
    if ((r.itens || []).length) linhas.push('Itens:', ...r.itens.map((it) => `- ${it.descricao}${it.quantidade ? ` (${it.quantidade})` : ''}${it.valor ? `: ${moeda(it.valor)}` : ''}`));
    const obsAntiga = $('#l-obs').value.trim();
    $('#l-obs').value = [linhas.join('\n'), obsAntiga].filter(Boolean).join('\n\n');
    ajustarTextos();
    // Nota já lançada antes? (mesmo número e mesmo CNPJ na observação)
    let repetida = false;
    if (r.numero_nota && r.cnpj_fornecedor) {
      repetida = (await todos('lancamentos')).some((x) => (x.observacao || '').includes(`NF nº ${r.numero_nota} `) && (x.observacao || '').includes(r.cnpj_fornecedor));
    }
    const avisos = [...(repetida ? ['Parece que esta nota já foi lançada antes (mesmo número e CNPJ). Confira para não lançar duas vezes.'] : []), ...(r.avisos || [])];
    $('#nf-res').innerHTML = `<div class="card" style="margin:.6rem 0 0;padding:.7rem .9rem">
      <p style="margin:0"><b>✓ Nota lida.</b> Confira os campos abaixo e toque em Salvar.</p>
      ${avisos.length ? `<ul style="margin:.4rem 0 0;padding-left:1.1rem">${avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      <p class="sub" style="margin:.4rem 0 0">Custo da leitura: ${textoGasto(usd)}</p></div>`;
  };
  if ($('#i-nf')) $('#i-nf').onchange = async (e) => {
    const arq = e.target.files[0]; e.target.value = '';
    if (!arq) return;
    let foto;
    try { aviso('Preparando foto...', 60000); foto = await processarFoto(arq); } catch (er) { aviso('Foto não pôde ser lida', 4000); return; }
    novosAnexos.push({ ...foto, legenda: 'Nota fiscal' }); desenharAnexos();
    const rotulo = $('#box-nf .add-foto'); rotulo.style.pointerEvents = 'none'; rotulo.firstChild.textContent = 'Lendo a nota com IA...';
    $('#nf-res').innerHTML = '';
    aviso('Lendo a nota com IA...', 90000);
    try {
      const { r, usd } = await lerNotaFiscal(foto.blob);
      await preencherNF(r, usd);
      aviso('Nota lida: confira e salve', 3500);
    } catch (er) {
      aviso('Erro: ' + er.message, 7000);
      $('#nf-res').innerHTML = `<p class="sub" style="margin:.5rem 0 0">Não deu para ler: ${esc(er.message)} A foto ficou anexada; preencha à mão ou tente outra foto.</p>`;
    }
    rotulo.style.pointerEvents = ''; rotulo.firstChild.textContent = '📷 Ler outra nota fiscal com IA';
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const valor = lerValor(d.valor);
    if (!d.descricao.trim() || valor <= 0) { aviso('Preencha a descrição e um valor maior que zero', 3500); return; }
    const base = {
      ...l, tipo: d.tipo, descricao: d.descricao.trim(), classificacao: d.classificacao, vencimento: d.vencimento,
      formaPagamento: d.formaPagamento, pago: !!d.pago, dataPagamento: d.pago ? (d.dataPagamento || hoje()) : '',
      observacao: d.observacao.trim(), atualizadoEm: agora()
    };
    if (!base.criadoEm) base.criadoEm = agora();
    const n = novo ? Math.max(1, Math.min(60, parseInt(d.parcelas, 10) || 1)) : 1;
    if (n === 1) { base.valor = valor; await gravar('lancamentos', base); }
    else {
      // Divide o total em centavos; a diferença do arredondamento fica na 1ª parcela.
      const cent = Math.round(valor * 100), parte = Math.floor(cent / n);
      for (let i = 0; i < n; i++) {
        await gravar('lancamentos', {
          ...base, id: i === 0 ? base.id : novoId(), descricao: `${base.descricao} (${i + 1}/${n})`,
          valor: (parte + (i === 0 ? cent - parte * n : 0)) / 100,
          vencimento: somarMeses(base.vencimento || hoje(), i),
          pago: i === 0 ? base.pago : false, dataPagamento: i === 0 ? base.dataPagamento : ''
        });
      }
    }
    for (const [i, a] of novosAnexos.entries()) {
      await gravar('fotos', { id: novoId(), lancamentoId: base.id, obraId: obra.id, ordem: Date.now() + i, legenda: 'Comprovante', criadoEm: agora(), atualizadoEm: agora(), ...a });
    }
    obra.atualizadoEm = agora(); await gravar('obras', obra);
    pedirArmazenamentoFixo();
    aviso(n > 1 ? `${n} parcelas lançadas` : 'Lançamento salvo');
    location.hash = voltar;
  };

  if (!novo) {
    $('#b-excluir-lanc').onclick = async () => {
      if (!confirm(`Excluir "${l.descricao}" (${moeda(l.valor)})? Isso não tem volta (a não ser por um backup).`)) return;
      for (const a of anexos) await excluir('fotos', a.id);
      await excluir('lancamentos', l.id);
      aviso('Lançamento excluído'); location.hash = voltar;
    };
  }
}

function verImagem(url) {
  const div = document.createElement('div');
  div.className = 'ver-imagem'; div.innerHTML = `<img src="${url}" alt="Comprovante"><button type="button" class="btn sec">Fechar</button>`;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
}

// Planilha Excel: aba LANÇAMENTOS (mesmas colunas da planilha da V&M + forma de pagamento e observação) e aba RESUMO.
async function exportarExcel(obraId, botao) {
  const txt = botao.textContent; botao.disabled = true; botao.textContent = 'Gerando planilha...';
  try {
    await carregarScript(XLSX_URL);
    const X = window.XLSX;
    let obras = (await todos('obras')).sort((a, b) => a.nome.localeCompare(b.nome));
    if (obraId) obras = obras.filter((o) => o.id === obraId);
    const nome = (id) => (obras.find((o) => o.id === id) || {}).nome || '';
    const ls = (obraId ? await porIndice('lancamentos', 'obraId', obraId) : await todos('lancamentos'))
      .filter((l) => nome(l.obraId))
      .sort((a, b) => nome(a.obraId).localeCompare(nome(b.obraId)) || (a.vencimento || '').localeCompare(b.vencimento || ''));
    // Data como número do Excel (evita erro de fuso horário)
    const serial = (iso) => { if (!iso) return ''; const [a, m, d] = iso.split('-').map(Number); return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };

    const linhas = [['CONTAS A PAGAR E RECEBER - OBRAS'],
      ['DESCRIÇÃO', 'DATA VENCIMENTO', 'CLASSIFICAÇÃO', 'TIPO', 'CENTRO DE CUSTO', 'VALOR', 'PAGAMENTO', 'DATA PAGAMENTO', 'STATUS', 'FORMA DE PAGAMENTO', 'OBSERVAÇÃO']];
    for (const l of ls) {
      // Igual à planilha da V&M: despesas com valor negativo, PAGAMENTO = "Pago"/"Em aberto", STATUS = Pago/Atrasado/À pagar
      const valor = (Number(l.valor) || 0) * (l.tipo === 'Pagar' ? -1 : 1);
      const st = statusDe(l) === 'Em dia' ? (l.tipo === 'Pagar' ? 'À pagar' : 'À receber') : statusDe(l);
      linhas.push([l.descricao, serial(l.vencimento), l.classificacao, l.tipo, nome(l.obraId).toUpperCase(), valor,
        l.pago ? 'Pago' : 'Em aberto', serial(l.dataPagamento), st, l.formaPagamento || '', l.observacao || '']);
    }
    const ws = X.utils.aoa_to_sheet(linhas);
    ws['!cols'] = [38, 15, 22, 9, 28, 14, 14, 15, 10, 18, 32].map((wch) => ({ wch }));
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }];
    const formatar = (planilha, nLinhas, colunas, z) => {
      for (let r = 1; r < nLinhas; r++) for (const c of colunas) { const cel = planilha[X.utils.encode_cell({ r, c })]; if (cel && cel.t === 'n') cel.z = z; }
    };
    formatar(ws, linhas.length, [5], '"R$" #,##0.00;-"R$" #,##0.00');
    formatar(ws, linhas.length, [1, 7], 'dd/mm/yyyy');

    const res = [['CENTRO DE CUSTO', 'VALOR DO CONTRATO', 'CUSTO PREVISTO', 'RECEBER (LANÇADO)', 'RECEBIDO', 'PAGAR (LANÇADO)', 'PAGO', 'SALDO EM CAIXA']];
    for (const o of obras) {
      const d = ls.filter((l) => l.obraId === o.id);
      const s = (f) => d.filter(f).reduce((t, l) => t + (Number(l.valor) || 0), 0);
      const rec = s((l) => l.tipo === 'Receber' && l.pago), pag = s((l) => l.tipo === 'Pagar' && l.pago);
      res.push([o.nome.toUpperCase(), Number(o.valorContrato) || 0, Number(o.custoPrevisto) || 0, s((l) => l.tipo === 'Receber'), rec, s((l) => l.tipo === 'Pagar'), pag, rec - pag]);
    }
    const wr = X.utils.aoa_to_sheet(res);
    wr['!cols'] = [30, 18, 16, 18, 14, 16, 14, 16].map((wch) => ({ wch }));
    formatar(wr, res.length, [1, 2, 3, 4, 5, 6, 7], '"R$" #,##0.00');

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, 'LANÇAMENTOS');
    X.utils.book_append_sheet(wb, wr, 'RESUMO');
    const tipo = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const blob = new Blob([X.write(wb, { bookType: 'xlsx', type: 'array' })], { type: tipo });
    const arq = `financeiro-${obraId ? slug(obras[0]?.nome) : 'todas-as-obras'}-${hoje()}.xlsx`;
    if (ehComputador()) { baixar(blob, arq); aviso('Planilha baixada (pasta Downloads)', 3500); }
    else {
      const r = await compartilharOuBaixar(blob, arq, tipo, 'Financeiro das obras');
      if (r === 'precisa-toque') baixar(blob, arq);
      if (r === 'baixado' || r === 'precisa-toque') aviso('Planilha baixada', 3500);
    }
  } catch (e) { console.error(e); aviso('Não foi possível gerar a planilha: ' + e.message, 5000); }
  botao.disabled = false; botao.textContent = txt;
}

// ---------------------------------------------------------------- PDF
let _logo;
async function logoDataUrl() {
  if (!_logo) _logo = await blobParaDataUrl(await (await fetch('img/logo-vm-clara.png')).blob());
  return _logo;
}

// Peças comuns dos PDFs: os três relatórios usam o mesmo cabeçalho, quadro, títulos, fotos, tabela e rodapé.
const COR = { NAVY: [11, 31, 51], AZUL: [59, 158, 255], TEXTO: [40, 52, 66], CINZA: [110, 124, 140], FUNDO: [241, 245, 249], LINHA: [214, 222, 230], VERDE: [21, 128, 61], VERMELHO: [190, 40, 40] };
// A fonte padrão do PDF não tem alguns símbolos (sinal de menos tipográfico, travessões)
const pdfTxt = (s) => String(s ?? '').replace(/[−–—]/g, '-');

async function reduzirImagem(blob, max) {
  const img = await createImageBitmap(blob);
  const r = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); if (img.close) img.close();
  return c.toDataURL('image/jpeg', 0.72);
}

async function criarPdf(tituloTopo, linhaTopo) {
  if (!window.jspdf) throw new Error('o gerador de PDF ainda não carregou. Abra o app uma vez com internet.');
  const logo = await logoDataUrl();
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const P = { doc, W: 210, H: 297, M: 15, y: 0 };
  P.LARG = P.W - 2 * P.M; P.FIM = P.H - 20;
  const { M, W, H, LARG } = P;

  P.cabecalho = () => {
    doc.setFillColor(...COR.NAVY); doc.rect(0, 0, W, 30, 'F');
    doc.addImage(logo, 'PNG', M, 6, 17.4, 18, 'logo', 'FAST');
    doc.setTextColor(241, 245, 249); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(tituloTopo, M + 23, 13.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(184, 199, 214);
    doc.text(doc.splitTextToSize(pdfTxt(linhaTopo), W - 2 * M - 23)[0], M + 23, 19.5);
    doc.text(`${EMPRESA.nome}  ·  ${EMPRESA.resp}  ·  ${EMPRESA.crea}`, M + 23, 24.5);
    P.y = 39;
  };
  P.cabe = (h) => { if (P.y + h > P.FIM) { doc.addPage(); P.cabecalho(); return true; } return false; };

  // junto = altura (mm) do que vem logo depois e não pode ficar separado do título (ex.: 1ª linha de fotos)
  P.titulo = (t, junto = 0) => {
    P.cabe(Math.max(16, 8 + junto));
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...COR.NAVY);
    doc.text(t.toUpperCase(), M, P.y);
    doc.setDrawColor(...COR.AZUL); doc.setLineWidth(0.6); doc.line(M, P.y + 1.8, M + 18, P.y + 1.8);
    P.y += 8;
  };
  // Faixa clara com borda azul (usada para cada visita no relatório da obra)
  P.subtitulo = (t, detalhe) => {
    const alt = detalhe ? 11.5 : 7;
    P.cabe(alt + 12);
    doc.setFillColor(...COR.FUNDO); doc.rect(M, P.y - 4.6, LARG, alt, 'F');
    doc.setDrawColor(...COR.AZUL); doc.setLineWidth(0.9); doc.line(M, P.y - 4.6, M, P.y - 4.6 + alt);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...COR.NAVY); doc.text(pdfTxt(t), M + 3, P.y);
    if (detalhe) {
      P.y += 4.8; doc.setFont('helvetica', 'normal'); doc.setFontSize(8.8); doc.setTextColor(...COR.CINZA);
      doc.text(doc.splitTextToSize(pdfTxt(detalhe), LARG - 6)[0], M + 3, P.y);
    }
    P.y += 8;
  };
  P.paragrafo = (txt, vazio = 'Sem registro.', tam = 10.5) => {
    const t = pdfTxt(txt).trim();
    doc.setFont('helvetica', t ? 'normal' : 'italic'); doc.setFontSize(tam); doc.setTextColor(...(t ? COR.TEXTO : COR.CINZA));
    const lh = tam * 0.495;
    for (const linha of doc.splitTextToSize(t || vazio, LARG)) { P.cabe(lh); doc.text(linha, M, P.y); P.y += lh; }
    P.y += 4;
  };
  // "Rótulo" em negrito e o texto embaixo (só aparece se tiver texto)
  P.campo = (rotulo, txt) => {
    const t = pdfTxt(txt).trim(); if (!t) return false;
    P.cabe(10);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...COR.NAVY); doc.text(rotulo, M, P.y); P.y += 4.6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...COR.TEXTO);
    for (const l of doc.splitTextToSize(t, LARG)) { P.cabe(4.8); doc.text(l, M, P.y); P.y += 4.8; }
    P.y += 2.5;
    return true;
  };
  P.quadro = (linhas) => {
    linhas = linhas.filter(([, val]) => val);
    const alt = linhas.length * 6 + 5;
    P.cabe(alt);
    doc.setFillColor(...COR.FUNDO); doc.setDrawColor(...COR.LINHA); doc.setLineWidth(0.2);
    doc.roundedRect(M, P.y - 5, LARG, alt, 2, 2, 'FD');
    doc.setFontSize(10);
    for (const [rot, val] of linhas) {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...COR.CINZA); doc.text(rot, M + 4, P.y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...COR.TEXTO); doc.text(doc.splitTextToSize(pdfTxt(val), LARG - 50)[0], M + 45, P.y);
      P.y += 6;
    }
    P.y += 8;
  };
  // Fotos em grade (2 por linha na visita; 3 por linha, reduzidas, no relatório da obra)
  P.fotos = async (fotos, { colunas = 2, maxH = 68, inicio = 1, reduzir = 0 } = {}) => {
    const tres = colunas > 2;
    const GAP = tres ? 4 : 6, COL = (LARG - GAP * (colunas - 1)) / colunas, fs = tres ? 8 : 9, lh = tres ? 3.6 : 4.2;
    for (let i = 0; i < fotos.length; i += colunas) {
      const grupo = fotos.slice(i, i + colunas).map((f, k) => {
        const h = Math.min(maxH, COL * f.altura / f.largura);
        doc.setFontSize(fs);
        return { f, h, w: h * f.largura / f.altura, leg: doc.splitTextToSize(`Foto ${inicio + i + k}${(f.legenda || '').trim() ? ' – ' + pdfTxt(f.legenda.trim()) : ''}`, COL) };
      });
      const alt = maxH + Math.max(...grupo.map((p) => p.leg.length)) * lh + (tres ? 5 : 7);
      P.cabe(alt);
      for (const [k, p] of grupo.entries()) {
        const x0 = M + k * (COL + GAP);
        doc.setFillColor(...COR.FUNDO); doc.rect(x0, P.y, COL, maxH, 'F');
        const img = reduzir ? await reduzirImagem(p.f.blob, reduzir) : await blobParaDataUrl(p.f.blob);
        doc.addImage(img, 'JPEG', x0 + (COL - p.w) / 2, P.y + (maxH - p.h) / 2, p.w, p.h, p.f.id, 'FAST');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(fs); doc.setTextColor(...COR.TEXTO);
        doc.text(p.leg, x0, P.y + maxH + (tres ? 3.8 : 4.5));
      }
      P.y += alt;
    }
  };
  // Tabela simples: colunas [{t, w, a:'right'}]; cor(i, j) pode devolver uma cor para a célula
  P.tabela = (cols, linhas, cor) => {
    const fs = 8.6, lh = 3.8, pad = 1.6;
    const posX = (x, c) => (c.a === 'right' ? x + c.w - pad : x + pad);
    const cab = () => {
      P.cabe(10);
      doc.setFillColor(...COR.NAVY); doc.rect(M, P.y - 4.2, LARG, 6.2, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(fs); doc.setTextColor(255, 255, 255);
      let x = M; for (const c of cols) { doc.text(c.t, posX(x, c), P.y, c.a === 'right' ? { align: 'right' } : undefined); x += c.w; }
      P.y += 5.4;
    };
    cab();
    linhas.forEach((ln, i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(fs);
      const partes = ln.map((v, j) => doc.splitTextToSize(pdfTxt(v), cols[j].w - 2 * pad).slice(0, 2));
      const h = Math.max(...partes.map((p) => p.length)) * lh + 1.8;
      if (P.y + h > P.FIM) { doc.addPage(); P.cabecalho(); cab(); }
      if (i % 2) { doc.setFillColor(...COR.FUNDO); doc.rect(M, P.y - 3.3, LARG, h, 'F'); }
      let x = M;
      partes.forEach((p, j) => {
        const c = cols[j];
        doc.setFont('helvetica', c.negrito ? 'bold' : 'normal');
        doc.setTextColor(...((cor && cor(i, j)) || COR.TEXTO));
        doc.text(p, posX(x, c), P.y, c.a === 'right' ? { align: 'right' } : undefined);
        x += c.w;
      });
      P.y += h;
    });
    P.y += 5;
  };
  // Faixa de total (escura) ou subtotal (clara), com o valor à direita
  P.total = (rot, val, escuro = true) => {
    P.cabe(10);
    doc.setFillColor(...(escuro ? COR.NAVY : COR.FUNDO)); doc.rect(M, P.y - 4.8, LARG, 7.4, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...(escuro ? [255, 255, 255] : COR.NAVY));
    doc.text(pdfTxt(rot), M + 3, P.y); doc.text(pdfTxt(val), M + LARG - 3, P.y, { align: 'right' });
    P.y += 9;
  };
  P.assinatura = (dataIso) => {
    P.cabe(38); P.y += 10;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...COR.TEXTO);
    doc.text(`Curitiba, ${dataExtenso(dataIso)}.`, M, P.y); P.y += 20;
    doc.setDrawColor(...COR.CINZA); doc.setLineWidth(0.3); doc.line(M, P.y, M + 80, P.y); P.y += 5;
    doc.setFont('helvetica', 'bold'); doc.text(EMPRESA.resp, M, P.y); P.y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...COR.CINZA);
    doc.text(`Engenheiro Civil  ·  ${EMPRESA.crea}`, M, P.y);
  };
  P.finalizar = (nome, aviso) => {
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setDrawColor(...COR.LINHA); doc.setLineWidth(0.2); doc.line(M, H - 13, W - M, H - 13);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...COR.CINZA);
      doc.text(`${EMPRESA.nome}  ·  CNPJ ${EMPRESA.cnpj}  ·  ${EMPRESA.cidade}${aviso ? '  ·  ' + aviso : ''}`, M, H - 8.5);
      doc.text(`Página ${p} de ${total}`, W - M, H - 8.5, { align: 'right' });
    }
    return { blob: doc.output('blob'), nome };
  };

  P.cabecalho();
  return P;
}

const textoClima = (v) => [v.climaManha && `manhã: ${v.climaManha}`, v.climaTarde && `tarde: ${v.climaTarde}`].filter(Boolean).join('  ·  ');

// 1) Relatório de UMA visita (para o cliente)
async function gerarPdf(visitaId) {
  const v = await pegar('visitas', visitaId);
  const obra = await pegar('obras', v.obraId);
  const visitas = (await porIndice('visitas', 'obraId', obra.id)).sort(porData);
  const num = visitas.findIndex((x) => x.id === v.id) + 1;
  const fotos = (await porIndice('fotos', 'visitaId', v.id)).sort((a, b) => a.ordem - b.ordem);

  const P = await criarPdf('RELATÓRIO DE ACOMPANHAMENTO DE OBRA', `nº ${num}  ·  ${dataBR(v.data)}  ·  ${obra.nome}`);
  P.quadro([
    ['Obra', obra.nome], ['Cliente', obra.cliente], ['Local', obra.local], ['ART nº', (obra.art || '').trim()],
    ['Data da visita', dataBR(v.data)], ['Clima', textoClima(v)], ['Condição do canteiro', v.condicao]
  ]);
  P.titulo('Equipe presente'); P.paragrafo(v.equipe);
  P.titulo('Atividades em execução'); P.paragrafo(v.atividades);
  P.titulo('Ocorrências'); P.paragrafo(v.ocorrencias);
  P.titulo('Orientações registradas'); P.paragrafo(v.orientacoes, 'Nenhuma orientação registrada nesta visita.');
  if ((v.observacao || '').trim()) { P.titulo('Observação'); P.paragrafo(v.observacao); }
  if (fotos.length) {
    P.titulo(`Relatório fotográfico (${fotos.length} foto${fotos.length > 1 ? 's' : ''})`, 68 + 3 * 4.2 + 7);   // título + 1ª linha de fotos (foto + até 3 linhas de legenda)
    await P.fotos(fotos);
  }
  P.assinatura(v.data);
  return P.finalizar(`Relatorio-acompanhamento-${num}-${slug(obra.nome)}-${v.data}.pdf`);
}

// 2) Relatório da OBRA num período (para o cliente; sem nada do financeiro)
async function gerarRelatorioObra(obraId, de, ate) {
  const obra = await pegar('obras', obraId);
  const todas = (await porIndice('visitas', 'obraId', obra.id)).sort(porData);
  const numero = new Map(todas.map((v, i) => [v.id, i + 1]));
  const vs = todas.filter((v) => (!de || v.data >= de) && (!ate || v.data <= ate));
  if (!vs.length) throw new Error('nenhuma visita nesse período');
  const fotosDe = new Map();
  let totalFotos = 0;
  for (const v of vs) { const f = (await porIndice('fotos', 'visitaId', v.id)).sort((a, b) => a.ordem - b.ordem); fotosDe.set(v.id, f); totalFotos += f.length; }
  const ini = de || vs[0].data, fim = ate || vs[vs.length - 1].data;
  const periodo = `${dataBR(ini)} a ${dataBR(fim)}`;

  const P = await criarPdf('RELATÓRIO DE ACOMPANHAMENTO DE OBRA', `Consolidado  ·  ${periodo}  ·  ${obra.nome}`);
  P.quadro([
    ['Obra', obra.nome], ['Cliente', obra.cliente], ['Local', obra.local], ['ART nº', (obra.art || '').trim()],
    ['Período', periodo], ['Visitas técnicas', String(vs.length)], ['Fotos', String(totalFotos)]
  ]);
  P.titulo('Visitas técnicas no período');
  let nFoto = 1;
  for (const v of vs) {
    const det = [textoClima(v), v.condicao && `canteiro ${v.condicao.toLowerCase()}`].filter(Boolean).join('  ·  ');
    P.subtitulo(`Visita nº ${numero.get(v.id)}  ·  ${dataBR(v.data)}`, det);
    let algo = false;
    algo = P.campo('Equipe presente', v.equipe) || algo;
    algo = P.campo('Atividades em execução', v.atividades) || algo;
    algo = P.campo('Ocorrências', v.ocorrencias) || algo;
    algo = P.campo('Orientações registradas', v.orientacoes) || algo;
    algo = P.campo('Observação', v.observacao) || algo;
    const fotos = fotosDe.get(v.id);
    if (!algo && !fotos.length) P.paragrafo('', 'Sem registros nesta visita.', 10);
    if (fotos.length) { P.y += 1; await P.fotos(fotos, { colunas: 3, maxH: 44, inicio: nFoto, reduzir: 1000 }); nFoto += fotos.length; }
    P.y += 4;
  }
  P.assinatura(hoje());
  return P.finalizar(`Relatorio-acompanhamento-consolidado-${slug(obra.nome)}-${ini}-a-${fim}.pdf`);
}

// 3) Relatório FINANCEIRO da obra (uso interno; nunca enviar ao cliente)
// categorias: null = relatório completo; ou lista das classificações escolhidas.
async function gerarRelatorioFinanceiro(obraId, categorias) {
  const obra = await pegar('obras', obraId);
  const todosLs = (await porIndice('lancamentos', 'obraId', obra.id))
    .sort((a, b) => (a.vencimento || '9999').localeCompare(b.vencimento || '9999') || (a.criadoEm || '').localeCompare(b.criadoEm || ''));
  const parcial = Array.isArray(categorias) && categorias.length > 0;
  const ls = parcial ? todosLs.filter((l) => categorias.includes(l.classificacao || 'Sem classificação')) : todosLs;
  if (!ls.length) throw new Error('nenhum lançamento nas categorias escolhidas');
  const soma = (f, lista = ls) => lista.filter(f).reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const receber = soma((l) => l.tipo === 'Receber'), recebido = soma((l) => l.tipo === 'Receber' && l.pago);
  const custos = soma((l) => l.tipo === 'Pagar'), pago = soma((l) => l.tipo === 'Pagar' && l.pago);
  const custosObra = soma((l) => l.tipo === 'Pagar', todosLs);
  const contrato = Number(obra.valorContrato) || 0, previsto = Number(obra.custoPrevisto) || 0;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  const saldo = recebido - pago;

  const P = await criarPdf(parcial ? 'RELATÓRIO FINANCEIRO POR CATEGORIA' : 'RELATÓRIO FINANCEIRO DA OBRA', `${obra.nome}  ·  uso interno  ·  ${dataBR(hoje())}`);
  P.quadro([
    ['Obra', obra.nome], ['Cliente', obra.cliente], ['Local', obra.local], ['Situação', situacaoDe(obra)],
    ...(parcial ? [['Categorias', categorias.join(', ')]] : []),
    ['Valor do contrato', contrato ? moeda(contrato) : 'não informado'], ['Custo previsto', previsto ? moeda(previsto) : 'não informado'],
    ['Lançamentos', parcial ? `${ls.length} de ${todosLs.length}` : String(ls.length)], ['Gerado em', dataBR(hoje())]
  ]);

  P.titulo(parcial ? 'Resumo das categorias escolhidas' : 'Resumo');
  const linhasResumo = parcial ? [
    ...(receber ? [['Recebido', moeda(recebido), ''], ['A receber (lançado, em aberto)', moeda(receber - recebido), '']] : []),
    ['Custos pagos', moeda(pago), ''],
    ['Custos a pagar (em aberto)', moeda(custos - pago), ''],
    ['Total de custos das categorias', moeda(custos), custosObra ? `${pct(custos, custosObra)} dos custos da obra` : ''],
    ...(previsto ? [['Peso no custo previsto da obra', pct(custos, previsto), '']] : [])
  ] : [
    ['Recebido', moeda(recebido), contrato ? `${pct(recebido, contrato)} do contrato` : ''],
    ['A receber (lançado, em aberto)', moeda(receber - recebido), ''],
    ...(contrato ? [['Falta receber do contrato', moeda(contrato - recebido), '']] : []),
    ['Custos pagos', moeda(pago), ''],
    ['Custos a pagar (em aberto)', moeda(custos - pago), ''],
    ['Total de custos lançados', moeda(custos), previsto ? `${pct(custos, previsto)} do previsto` : ''],
    ['Saldo em caixa (recebido - pago)', moeda(saldo), ''],
    ...(contrato ? [['Resultado previsto (contrato - custos lançados)', moeda(contrato - custos), '']] : [])
  ];
  P.tabela([{ t: 'Item', w: 95 }, { t: 'Valor', w: 45, a: 'right', negrito: true }, { t: 'Referência', w: 40, a: 'right' }], linhasResumo,
    (i, j) => {
      const rot = linhasResumo[i][0];
      if (j === 1 && rot.startsWith('Saldo')) return saldo < 0 ? COR.VERMELHO : COR.VERDE;
      if (j === 2 && !parcial && rot.startsWith('Total de custos') && previsto && custos > previsto) return COR.VERMELHO;
      return null;
    });

  const porClasse = CLASSIFICACOES.map((c) => [c, soma((l) => l.tipo === 'Pagar' && l.classificacao === c)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (porClasse.length) {
    P.titulo('Custos por classificação');
    P.tabela([{ t: 'Classificação', w: 100 }, { t: 'Valor', w: 45, a: 'right' }, { t: '% dos custos', w: 35, a: 'right' }],
      porClasse.map(([c, v]) => [c, moeda(v), pct(v, custos)]));
  }

  const situacao = (l) => (l.pago ? (l.tipo === 'Receber' ? 'Recebido' : 'Pago') : (statusDe(l) === 'Atrasado' ? 'Atrasado' : 'Em aberto'));
  const corSituacao = (lista) => (i, j) => {
    if (j === 4) return lista[i].tipo === 'Receber' ? COR.VERDE : null;
    if (j === 5) { const s = situacao(lista[i]); return s === 'Atrasado' ? COR.VERMELHO : (s === 'Pago' || s === 'Recebido' ? COR.VERDE : null); }
    return null;
  };
  const colunas = [{ t: 'Data', w: 20 }, { t: 'Descrição', w: 64 }, { t: 'Classificação', w: 32 }, { t: 'Tipo', w: 16 }, { t: 'Valor', w: 28, a: 'right' }, { t: 'Situação', w: 20 }];
  const linha = (l, data) => [data ? dataBR(data) : 'sem data', l.descricao, l.classificacao, l.tipo, `${l.tipo === 'Receber' ? '+' : '-'} ${moeda(l.valor)}`, situacao(l)];

  const abertos = ls.filter((l) => !l.pago).sort((a, b) => (statusDe(b) === 'Atrasado') - (statusDe(a) === 'Atrasado') || (a.vencimento || '9999').localeCompare(b.vencimento || '9999'));
  P.titulo(`Contas em aberto (${abertos.length})`);
  if (abertos.length) P.tabela(colunas.map((c, i) => (i === 0 ? { ...c, t: 'Vencimento' } : c)), abertos.map((l) => linha(l, l.vencimento)), corSituacao(abertos));
  else P.paragrafo('', 'Nenhuma conta em aberto.', 10);

  if (ls.length) {
    P.titulo(`Todos os lançamentos (${ls.length})`);
    P.paragrafo('Data = data do pagamento quando já pago; senão, o vencimento.', '', 8.5);
    P.y -= 2;
    P.tabela(colunas, ls.map((l) => linha(l, l.pago && l.dataPagamento ? l.dataPagamento : l.vencimento)), corSituacao(ls));
  }
  return P.finalizar(`Relatorio-financeiro-${slug(obra.nome)}${parcial ? '-categorias' : ''}-${hoje()}.pdf`, 'documento interno');
}

// Botão que gera um PDF e envia (Compartilhar do celular) ou baixa
async function acaoPdf(botao, gerador, modo, titulo) {
  if (_salvarPendente) await _salvarPendente();
  const texto = botao.textContent, clique = botao.onclick;
  botao.disabled = true; botao.textContent = 'Gerando PDF...';
  try {
    const { blob, nome } = await gerador();
    if (modo === 'baixar') { baixar(blob, nome); aviso('PDF baixado'); }
    else {
      const r = await compartilharOuBaixar(blob, nome, 'application/pdf', titulo);
      if (r === 'baixado') aviso('PDF baixado (este aparelho não abriu o Compartilhar)');
      if (r === 'precisa-toque') {
        // O celular só abre o Compartilhar logo após um toque: o PDF está pronto, falta um toque.
        botao.disabled = false; botao.textContent = 'PDF pronto: toque para enviar';
        botao.onclick = async () => { botao.onclick = clique; botao.textContent = texto; await compartilharOuBaixar(blob, nome, 'application/pdf', titulo); };
        return;
      }
    }
  } catch (e) { console.error(e); aviso('Não foi possível gerar o PDF: ' + e.message, 5000); }
  botao.disabled = false; botao.textContent = texto;
}

// ---------------------------------------------------------------- backup
async function fazerBackup() {
  const b = $('#b-backup'); b.disabled = true; b.textContent = 'Preparando...';
  try {
    const [obras, visitas, fotos, lancamentos, excluidos, orcamentos, modelos, ajustes] = await Promise.all([todos('obras'), todos('visitas'), todos('fotos'), todos('lancamentos'), todos('excluidos'), todos('orcamentos'), todos('modelos'), todos('ajustes')]);
    const fotosJson = [];
    for (const f of fotos) { const { blob, ...resto } = f; fotosJson.push({ ...resto, dados: await blobParaDataUrl(blob) }); }
    const json = JSON.stringify({ app: 'obras-vm', versao: 2, exportadoEm: agora(), obras, visitas, lancamentos, orcamentos, modelos, ajustes, excluidos, fotos: fotosJson });
    const nome = `backup-obras-vm-${hoje()}.json`;
    if (ehComputador()) { baixar(new Blob([json], { type: 'application/json' }), nome); aviso('Backup baixado (pasta Downloads)', 4000); b.disabled = false; b.textContent = 'Fazer backup'; return; }
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
  dados.lancamentos = dados.lancamentos || []; dados.excluidos = dados.excluidos || []; dados.orcamentos = dados.orcamentos || []; dados.modelos = dados.modelos || []; dados.ajustes = dados.ajustes || [];
  if (!confirm(`Restaurar backup de ${new Date(dados.exportadoEm).toLocaleString('pt-BR')}?\n${dados.obras.length} obra(s), ${dados.visitas.length} visita(s), ${dados.lancamentos.length} lançamento(s), ${dados.fotos.length} foto(s).\n\nO backup é juntado ao que já existe aqui; quando o mesmo registro existe nos dois, fica a versão mais recente.`)) return;
  const juntar = async (loja, item) => {
    const atual = await pegar(loja, item.id);
    if (!atual || (item.atualizadoEm || '') >= (atual.atualizadoEm || '')) { await gravar(loja, item); return 1; }
    return 0;
  };
  let n = 0;
  for (const o of dados.obras) n += await juntar('obras', o);
  for (const v of dados.visitas) n += await juntar('visitas', v);
  for (const l of dados.lancamentos) n += await juntar('lancamentos', l);
  for (const o of dados.orcamentos) n += await juntar('orcamentos', o);
  for (const m of dados.modelos) n += await juntar('modelos', m);
  for (const a of dados.ajustes) n += await juntar('ajustes', a);
  for (const f of dados.fotos) {
    const { dados: d, ...resto } = f;
    n += await juntar('fotos', { ...resto, blob: await (await fetch(d)).blob() });
  }
  pedirArmazenamentoFixo();
  aviso(`Backup restaurado (${n} registro(s) atualizados)`, 4000);
  rota();
}

// ---------------------------------------------------------------- sincronização (Google Drive)
// No Drive, numa pasta escondida só do app (appDataFolder):
//   dados.json      -> obras, visitas, lançamentos, dados das fotos (sem a imagem) e exclusões
//   foto-<id>.jpg   -> cada foto/comprovante (enviada uma única vez)
// Junta aparelho + Drive: no mesmo registro fica o editado por último; exclusões valem nos dois.
const GOOGLE_CLIENT_ID = '175344161275-uojv66bmoob1ab1r2bls69gg75pcr82p.apps.googleusercontent.com';
const ESCOPO_DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const LOJAS_SYNC = ['obras', 'visitas', 'lancamentos', 'orcamentos', 'modelos', 'ajustes'];

let _sincronizando = false, _timerSync, _estadoSync = '', _tokenClient, _respostaToken;
const ls = { // localStorage pode falhar (modo anônimo): nunca deixar isso quebrar o app
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignora */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignora */ } }
};
const driveConectado = () => ls.get('drive-conectado') === '1';
function ultimaSync() {
  const t = ls.get('drive-ultima'); if (!t) return 'ainda não';
  const d = new Date(t); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}
function tokenValido() {
  try { const t = JSON.parse(ls.get('drive-token') || 'null'); return t && t.expira > Date.now() + 60000 ? t.valor : null; } catch (e) { return null; }
}

function aoMudar() {
  if (_sincronizando || !driveConectado()) return;
  clearTimeout(_timerSync);
  _timerSync = setTimeout(() => sincronizar(false), 8000);
  mostrarSync('pendente');
}

function mostrarSync(estado) {
  if (estado) _estadoSync = estado;
  const el = $('#status-rede'); if (!el) return;
  let txt, alerta = false;
  if (!navigator.onLine) { txt = 'sem internet · salvo no aparelho'; alerta = true; }
  else if (!driveConectado()) txt = 'só neste aparelho';
  else txt = {
    sincronizando: 'sincronizando…', pendente: 'alterações a enviar', ok: '✓ sincronizado',
    toque: 'toque para sincronizar', erro: 'erro · toque para tentar'
  }[_estadoSync] || 'Drive conectado';
  if (['toque', 'erro'].includes(_estadoSync) && navigator.onLine && driveConectado()) alerta = true;
  el.textContent = txt; el.classList.toggle('off', alerta);
}

function prepararGoogle() {
  return carregarScript(GIS_URL).then(() => {
    if (!_tokenClient) {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID, scope: ESCOPO_DRIVE,
        callback: (r) => _respostaToken && _respostaToken(r),
        error_callback: (e) => _respostaToken && _respostaToken({ error: e.type || 'popup' })
      });
    }
  });
}
// Abre a janelinha do Google (precisa ser logo após um toque do usuário).
function pedirToken() {
  return new Promise((ok, erro) => {
    _respostaToken = (r) => {
      _respostaToken = null;
      if (r.error || !r.access_token) { erro(new Error(r.error === 'popup_closed' ? 'janela do Google fechada' : (r.error || 'acesso negado'))); return; }
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, ESCOPO_DRIVE)) { erro(new Error('é preciso permitir o acesso ao Drive')); return; }
      ls.set('drive-token', JSON.stringify({ valor: r.access_token, expira: Date.now() + (r.expires_in || 3600) * 1000 }));
      ok(r.access_token);
    };
    _tokenClient.requestAccessToken({ prompt: driveConectado() ? '' : 'consent' });
  });
}

async function driveFetch(token, url, op = {}) {
  const r = await fetch(url, { ...op, headers: { ...(op.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401) { ls.del('drive-token'); throw Object.assign(new Error('acesso ao Drive expirou'), { precisaToque: true }); }
  if (!r.ok) throw new Error(`Drive respondeu ${r.status}`);
  return r;
}
async function driveListar(token) {
  const arquivos = {}; let pagina = '';
  do {
    const r = await (await driveFetch(token, `${API}?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name)${pagina ? '&pageToken=' + pagina : ''}`)).json();
    for (const f of r.files || []) arquivos[f.name] = f.id;
    pagina = r.nextPageToken || '';
  } while (pagina);
  return arquivos;
}
function driveEnviar(token, nome, conteudo, tipo, idExistente) {
  if (idExistente) return driveFetch(token, `${UPLOAD}/${idExistente}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': tipo }, body: conteudo });
  const limite = 'obrasvm' + Date.now();
  const corpo = new Blob([
    `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify({ name: nome, parents: ['appDataFolder'] }),
    `\r\n--${limite}\r\nContent-Type: ${tipo}\r\n\r\n`, conteudo, `\r\n--${limite}--`
  ]);
  return driveFetch(token, `${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${limite}` }, body: corpo });
}

async function sincronizar(peloUsuario) {
  if (_sincronizando) return;
  clearTimeout(_timerSync);
  if (!navigator.onLine) { if (peloUsuario) aviso('Sem internet. Os dados estão salvos no aparelho e serão enviados depois.', 4000); mostrarSync(); return; }
  let token = tokenValido();
  try {
    if (!token) {
      if (!peloUsuario) { mostrarSync('toque'); return; }
      await prepararGoogle();
      token = await pedirToken();
    }
  } catch (e) { aviso('Não conectou ao Google: ' + e.message, 5000); mostrarSync('toque'); return; }

  _sincronizando = true; mostrarSync('sincronizando');
  let mudouAqui = 0;
  try {
    const arquivos = await driveListar(token);
    const remoto = arquivos['dados.json']
      ? await (await driveFetch(token, `${API}/${arquivos['dados.json']}?alt=media`)).json()
      : {};

    // 1. Exclusões: junta as dos dois lados
    const lapides = new Map();
    for (const e of [...(remoto.excluidos || []), ...(await todos('excluidos'))]) {
      if (!lapides.has(e.id) || lapides.get(e.id).em < e.em) lapides.set(e.id, e);
    }
    for (const e of lapides.values()) await tx('excluidos', 'readwrite', (s) => s.put(e));

    // 2. Obras, visitas e lançamentos: fica o mais recente
    const final = { excluidos: [...lapides.values()] };
    for (const loja of LOJAS_SYNC) {
      const locais = await todos(loja);
      const mapa = new Map(locais.map((x) => [x.id, x]));
      for (const r of remoto[loja] || []) {
        const l = mapa.get(r.id);
        if (!l || (r.atualizadoEm || '') > (l.atualizadoEm || '')) { mapa.set(r.id, r); await tx(loja, 'readwrite', (s) => s.put(r)); mudouAqui++; }
      }
      for (const id of [...mapa.keys()]) {
        if (lapides.has(id)) { if (locais.some((x) => x.id === id)) { await tx(loja, 'readwrite', (s) => s.delete(id)); mudouAqui++; } mapa.delete(id); }
      }
      final[loja] = [...mapa.values()];
    }

    // 3. Fotos: dados (legenda etc.) pelo mais recente; a imagem vai/vem como arquivo próprio
    const fotosLocais = new Map((await todos('fotos')).map((f) => [f.id, f]));
    const fotosFinal = new Map();
    for (const f of fotosLocais.values()) { const { blob, ...meta } = f; fotosFinal.set(f.id, meta); }
    for (const r of remoto.fotos || []) {
      const l = fotosLocais.get(r.id);
      if (!l) {
        if (lapides.has(r.id)) continue;
        fotosFinal.set(r.id, r);
        const arq = arquivos[`foto-${r.id}.jpg`];
        if (arq) { const blob = await (await driveFetch(token, `${API}/${arq}?alt=media`)).blob(); await tx('fotos', 'readwrite', (s) => s.put({ ...r, blob })); mudouAqui++; }
      } else if ((r.atualizadoEm || '') > (l.atualizadoEm || '')) {
        fotosFinal.set(r.id, r); await tx('fotos', 'readwrite', (s) => s.put({ ...r, blob: l.blob })); mudouAqui++;
      }
    }
    for (const id of lapides.keys()) {
      fotosFinal.delete(id);
      if (fotosLocais.has(id)) { await tx('fotos', 'readwrite', (s) => s.delete(id)); mudouAqui++; }
      // imagem excluída: apaga também o arquivo no Drive
      if (arquivos[`foto-${id}.jpg`]) await driveFetch(token, `${API}/${arquivos[`foto-${id}.jpg`]}`, { method: 'DELETE' }).catch(() => {});
    }
    // envia as imagens que o Drive ainda não tem
    const faltam = [...fotosLocais.values()].filter((f) => fotosFinal.has(f.id) && f.blob && !arquivos[`foto-${f.id}.jpg`]);
    for (const [i, f] of faltam.entries()) {
      if (faltam.length > 1) $('#status-rede').textContent = `enviando foto ${i + 1}/${faltam.length}…`;
      await driveEnviar(token, `foto-${f.id}.jpg`, f.blob, 'image/jpeg');
    }
    final.fotos = [...fotosFinal.values()];

    // 4. Grava o dados.json juntado
    // ...remoto primeiro: guarda partes que uma versão mais nova do app tenha criado
    const json = JSON.stringify({ ...remoto, app: 'obras-vm', versao: 2, atualizadoEm: agora(), ...final });
    await driveEnviar(token, 'dados.json', new Blob([json], { type: 'application/json' }), 'application/json', arquivos['dados.json']);

    ls.set('drive-conectado', '1'); ls.set('drive-ultima', agora());
    mostrarSync('ok');
    if (peloUsuario) aviso(mudouAqui ? `Sincronizado: ${mudouAqui} atualização(ões) recebida(s)` : 'Sincronizado com o Drive');
  } catch (e) {
    console.error(e);
    mostrarSync(e.precisaToque ? 'toque' : 'erro');
    if (peloUsuario || !e.precisaToque) aviso('Sincronização: ' + e.message, 5000);
  } finally { _sincronizando = false; }

  // Atualiza a tela se chegou coisa nova (sem atrapalhar quem está digitando um formulário)
  const tela = location.hash.replace(/^#\/?/, '').split('/')[0];
  if ((mudouAqui || peloUsuario) && ['', 'obra', 'orcamentos', 'modelos', 'ia'].includes(tela) && !_salvarPendente) rota();
  else if (mudouAqui) aviso('Chegaram dados novos do Drive');
}

function desconectarDrive() {
  if (!confirm('Desligar a sincronização neste aparelho? Os dados continuam aqui e no Drive; só param de sincronizar.')) return;
  const t = tokenValido();
  if (t && window.google) try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignora */ }
  ls.del('drive-conectado'); ls.del('drive-token'); ls.del('drive-ultima');
  mostrarSync(''); rota();
}

// ---------------------------------------------------------------- início
function mostrarRede() { mostrarSync(); if (navigator.onLine && driveConectado()) sincronizar(false); }
$('#status-rede').onclick = () => { if (driveConectado()) sincronizar(true); else location.hash = '#/'; };
window.addEventListener('online', mostrarRede);
window.addEventListener('offline', () => mostrarSync());
document.addEventListener('visibilitychange', () => { if (!document.hidden && driveConectado() && navigator.onLine && tokenValido()) sincronizar(false); });
window.addEventListener('hashchange', rota);
document.addEventListener('visibilitychange', () => { if (document.hidden && _salvarPendente) _salvarPendente(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Quando chega uma versão nova do app, recarrega para usá-la: na hora, se você está numa lista;
  // se está num formulário, só quando sair dele (o que você digitou é salvo antes).
  const tinhaVersao = !!navigator.serviceWorker.controller;
  const naLista = () => ['', 'orcamentos', 'modelos', 'ia'].includes(location.hash.replace(/^#\/?/, '').split('/')[0]);
  let recarregarAoSair = false;
  const recarregar = async () => {
    if (_salvarPendente) await _salvarPendente();
    try { sessionStorage.setItem('app-atualizado', '1'); } catch (e) { /* sem armazenamento */ }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinhaVersao) return;
    if (naLista()) recarregar(); else recarregarAoSair = true;
  });
  window.addEventListener('hashchange', () => { if (recarregarAoSair && naLista()) recarregar(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Ao voltar para o app, confere se saiu versão nova
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); });
  }).catch(console.error);
  try {
    if (sessionStorage.getItem('app-atualizado')) {
      sessionStorage.removeItem('app-atualizado');
      setTimeout(() => aviso(`App atualizado: versão ${VERSAO_APP}`, 3500), 600);
    }
  } catch (e) { /* sem armazenamento */ }
}
mostrarRede();
rota();
