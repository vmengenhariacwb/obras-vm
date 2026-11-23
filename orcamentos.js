'use strict';
// Orçamentos: vistoria técnica -> orçamento -> enviado -> aprovado/recusado -> "Transformar em obra".
// Usa as funções do app.js (banco, telas, PDF). Fotos da vistoria ficam na loja "fotos"
// com visitaId = obraId = id do orçamento; ao virar obra, passam para a primeira visita da obra.

const SITUACOES_ORC = ['Vistoria', 'Orçando', 'Enviado', 'Aprovado', 'Recusado'];
const FORNECIMENTO = {
  global: 'Material e mão de obra',
  mo: 'Só mão de obra (material por conta do cliente)'
};
// Mesmos dados e regras da proposta oficial da V&M (skill proposta-vm)
const CONTATO = {
  whatsapp: '(41) 99804-2520', email: 'contato.vmengenharia@hotmail.com', instagram: '@vm.eng.curitiba',
  endereco: 'Rua Augusto Zibarth, 936, Uberaba, Curitiba/PR', site: 'vmengenhariacwb.github.io'
};
const PAGAMENTO_PADRAO = '30% de entrada e saldo conforme o andamento dos serviços.';
const FRASES_PROIBIDAS = [
  [/equipe de arquitetos/i, 'equipe de arquitetos'], [/engenharia e arquitetura/i, 'engenharia e arquitetura'],
  [/\barquitetos?\b/i, 'arquiteto(s)'], [/\bRRT\b/i, 'RRT'], [/\bCAU\b/i, 'CAU'], [/baldr/i, 'BALDRA'], [/made with gamma/i, 'Made with Gamma']
];
// Confere os textos que vão para o cliente; devolve a lista de problemas (vazia = tudo certo)
function conferirOrcamento(o, completa) {
  const textos = [o.servico, o.necessidade, o.prazo, o.pagamento, o.observacoes, ...(o.itens || []).map((it) => it.descricao)].join('\n');
  const prob = FRASES_PROIBIDAS.filter(([re]) => re.test(textos)).map(([, f]) => `tirar a expressão "${f}" (a V&M é engenharia civil e emite ART)`);
  if (/\[[^\]]*\]|a definir/i.test(textos)) prob.push('há texto por preencher ("[...]" ou "a definir")');
  if (completa) {
    if (!(o.cliente || '').trim()) prob.push('preencher o nome do cliente');
    if (!(o.servico || '').trim()) prob.push('preencher o serviço (título)');
    if (!(o.necessidade || '').trim()) prob.push('preencher a necessidade / escopo');
    if (!(o.prazo || '').trim()) prob.push('preencher o prazo de execução');
    (o.itens || []).forEach((it, i) => {
      const v = o.fornecimento === 'mo' ? it.valorMo : it.valor;
      if ((it.descricao || '').trim() && !(Number(v) > 0)) prob.push(`item ${i + 1} está sem valor`);
      if (!(it.descricao || '').trim() && Number(v) > 0) prob.push(`item ${i + 1} está sem descrição`);
    });
  }
  return prob;
}
const centavos = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qtdTexto = (n) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function totaisOrc(o) {
  const its = o.itens || [];
  const soma = (f) => centavos(its.reduce((s, it) => s + centavos((Number(it.qtd) || 0) * (Number(f(it)) || 0)), 0));
  if (o.fornecimento === 'mo') {
    const mo = soma((it) => it.valorMo), mat = soma((it) => it.valorMat);
    return { contrato: mo, mo, mat };
  }
  return { contrato: soma((it) => it.valor), mo: 0, mat: 0 };
}

// ---------------------------------------------------------------- lista
async function telaOrcamentos(main) {
  const os = (await todos('orcamentos')).sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || ''));
  const abertos = os.filter((o) => !['Aprovado', 'Recusado'].includes(o.situacao));
  const aprovados = os.filter((o) => o.situacao === 'Aprovado');
  const recusados = os.filter((o) => o.situacao === 'Recusado');
  const item = (o) => {
    const ret = o.situacao === 'Enviado' && o.retornarEm
      ? ` · <span class="${o.retornarEm <= hoje() ? 'alerta' : ''}">retornar ${dataBR(o.retornarEm)}</span>` : '';
    return `<li><a class="item lanc" href="#/orcamento/${o.id}">
      <span><strong>${esc(o.servico || 'Orçamento sem título')}</strong>
        <small>${o.numero ? 'nº ' + esc(o.numero) + ' · ' : ''}${esc([o.cliente, o.local].filter(Boolean).join(' · ') || 'sem cliente')}${ret}</small></span>
      <span class="valor"><b>${moeda(totaisOrc(o).contrato)}</b><em class="st st-${slug(o.situacao)}">${esc(o.situacao)}</em></span>
    </a></li>`;
  };
  const lista = (l) => `<ul class="lista">${l.map(item).join('')}</ul>`;

  main.innerHTML = `
    <nav class="abas">
      <a href="#/">Obras</a>
      <a href="#/orcamentos" aria-current="page">Orçamentos</a>
    </nav>
    <h1>Orçamentos</h1>
    <p class="sub">Vistoria técnica, orçamento e proposta. Aprovou? Vira obra com um toque.</p>
    <h2>Em aberto (${abertos.length})</h2>
    ${abertos.length ? lista(abertos) : '<p class="vazio">Nenhum orçamento em aberto. Toque em <b>+ Nova vistoria</b> quando for ver uma obra.</p>'}
    ${aprovados.length ? `<details class="grupo"><summary>Aprovados (${aprovados.length})</summary>${lista(aprovados)}</details>` : ''}
    ${recusados.length ? `<details class="grupo"><summary>Recusados (${recusados.length})</summary>${lista(recusados)}</details>` : ''}
    <button class="btn flutuante" id="b-nova-vistoria" type="button">+ Nova vistoria</button>`;

  $('#b-nova-vistoria').onclick = async () => {
    const ano = hoje().slice(0, 4);
    const doAno = os.filter((o) => (o.numero || '').startsWith(ano + '-')).map((o) => parseInt(o.numero.slice(5), 10) || 0);
    const o = {
      id: novoId(), numero: `${ano}-${String(Math.max(0, ...doAno) + 1).padStart(3, '0')}`, situacao: 'Vistoria',
      data: hoje(), cliente: '', telefone: '', local: '', servico: '', necessidade: '', medidas: '',
      fornecimento: 'global', itens: [{ id: novoId(), descricao: '', un: '', qtd: 1, valor: 0, valorMo: 0, valorMat: 0 }],
      prazo: '', pagamento: '', validadeDias: 30, observacoes: '', custoEstimado: 0, retornarEm: '',
      criadoEm: agora(), atualizadoEm: agora()
    };
    await gravar('orcamentos', o);
    pedirArmazenamentoFixo();
    location.hash = '#/orcamento/' + o.id;
  };
}

// ---------------------------------------------------------------- vistoria + orçamento
async function telaOrcamento(main, id) {
  const o = await pegar('orcamentos', id);
  if (!o) { location.hash = '#/orcamentos'; return; }
  o.itens = o.itens || [];
  const obra = o.obraId ? await pegar('obras', o.obraId) : null;
  const txt = (nome, titulo, dica = '', tipo = 'text', extra = '') => `
    <label for="o-${nome}">${titulo}</label>
    <input id="o-${nome}" name="${nome}" type="${tipo}" value="${esc(o[nome])}" placeholder="${esc(dica)}" ${extra}>`;
  const area = (nome, titulo, dica) => `
    <label for="o-${nome}">${titulo}</label>
    <textarea id="o-${nome}" name="${nome}" placeholder="${esc(dica)}">${esc(o[nome])}</textarea>`;

  main.innerHTML = `
    <a class="voltar" href="#/orcamentos">‹ Orçamentos</a>
    <h1 id="t-orc">${esc(o.servico || 'Nova vistoria')}</h1>
    <p class="sub">nº ${esc(o.numero)} · <em class="st st-${slug(o.situacao)}" id="st-orc">${esc(o.situacao)}</em></p>
    ${obra ? `<p class="card" style="margin-top:0">Este orçamento virou a obra <a href="#/obra/${obra.id}"><b>${esc(obra.nome)}</b></a>.</p>` : ''}

    <form id="f-orc" class="card" autocomplete="off">
      <div class="duas">
        <div><label for="o-situacao">Situação</label><select id="o-situacao" name="situacao">${opcoes(SITUACOES_ORC, o.situacao)}</select></div>
        <div id="box-retorno" ${o.situacao === 'Enviado' ? '' : 'hidden'}>${txt('retornarEm', 'Retornar ao cliente em', '', 'date')}</div>
      </div>

      <h2>1. Vistoria técnica</h2>
      <div class="duas">
        <div>${txt('data', 'Data da vistoria', '', 'date')}</div>
        <div>${txt('numero', 'Nº do orçamento')}</div>
      </div>
      ${txt('servico', 'Serviço (título)', 'Ex.: Troca de telhado · Reforma de banheiro')}
      ${txt('cliente', 'Cliente')}
      <div class="duas">
        <div>${txt('telefone', 'Telefone', '(41) 9...', 'tel', 'inputmode="tel"')}</div>
        <div>${txt('local', 'Local (bairro e cidade)', 'Ex.: Uberaba, Curitiba/PR')}</div>
      </div>
      ${area('necessidade', 'Necessidade / escopo (vai no PDF)', 'O que o cliente precisa e o que será feito')}
      ${area('medidas', 'Medidas e anotações (só para você)', 'Medidas, materiais existentes, acesso, observações...')}
      <p class="salvo" id="salvo"></p>
    </form>

    <h2>Fotos da vistoria</h2>
    ${obra ? '<p class="sub">As fotos da vistoria foram para o diário da obra (primeira visita).</p>' : '<div class="fotos" id="fotos"></div>'}

    <form id="f-orc2" class="card" autocomplete="off" style="margin-top:1rem">
      <h2 style="margin-top:0">2. Orçamento</h2>
      <label>Fornecimento</label>
      <div class="segmento" role="radiogroup" aria-label="Fornecimento">
        <label><input type="radio" name="fornecimento" value="global" ${o.fornecimento !== 'mo' ? 'checked' : ''}><span>Material + mão de obra</span></label>
        <label><input type="radio" name="fornecimento" value="mo" ${o.fornecimento === 'mo' ? 'checked' : ''}><span>Só mão de obra</span></label>
      </div>
      <p class="sub" id="dica-forn" style="margin:.5rem 0 0"></p>
      <div id="itens"></div>
      <div class="botoes"><button class="btn sec" id="b-add-item" type="button">+ Adicionar item</button></div>
      <div class="card totais" id="totais" style="margin:1rem 0 0"></div>

      ${area('prazo', 'Prazo de execução', 'Ex.: 15 dias úteis após o início')}
      ${area('pagamento', 'Forma de pagamento', 'Em branco = padrão: 30% de entrada e saldo conforme o andamento')}
      <div class="duas">
        <div>${txt('validadeDias', 'Validade da proposta (dias)', '30', 'number', 'min="1" inputmode="numeric"')}</div>
        <div>${txt('custoEstimado', 'Seu custo estimado (R$)', '0,00', 'text', 'inputmode="decimal"')}</div>
      </div>
      <p class="sub" style="margin:.3rem 0 0">O custo estimado é só para você (não vai no PDF): no "Só mão de obra", coloque só o que você vai gastar (mão de obra), sem o material do cliente. Ao virar obra, ele vira o "custo previsto".</p>
      ${area('observacoes', 'Observações para o cliente (vai no PDF)', 'Ex.: Não inclui pintura. Entulho por conta do cliente.')}
      <p class="salvo" id="salvo2"></p>
    </form>

    <h2>3. Enviar ao cliente</h2>
    <div class="segmento" role="radiogroup" aria-label="Modelo do PDF">
      <label><input type="radio" name="modelo-pdf" value="completa" checked><span>Proposta completa</span></label>
      <label><input type="radio" name="modelo-pdf" value="simples"><span>PDF simples</span></label>
    </div>
    <p class="sub" id="dica-modelo" style="margin:.5rem 0 0"></p>
    <div class="botoes lado">
      <button class="btn zap" id="b-orc-enviar" type="button">Gerar PDF e enviar</button>
      <button class="btn sec" id="b-orc-baixar" type="button">Baixar PDF</button>
    </div>
    ${obra ? '' : '<div class="botoes"><button class="btn" id="b-virar-obra" type="button">Aprovado: transformar em obra</button></div>'}
    <div class="botoes"><button class="btn perigo" id="b-excluir-orc" type="button">Excluir orçamento</button></div>`;

  $('#o-custoEstimado').value = valorCampo(o.custoEstimado);
  const ehMo = () => o.fornecimento === 'mo';

  // ----- itens
  const desenharItens = () => {
    $('#dica-forn').textContent = ehMo()
      ? 'O PDF mostra a mão de obra (valor da proposta) e, separada, a estimativa de materiais que o cliente compra.'
      : 'O PDF mostra um valor só por item, com material e mão de obra juntos.';
    $('#itens').innerHTML = o.itens.map((it, i) => `
      <div class="item-orc" data-i="${i}">
        <div class="topo-item"><b>Item ${i + 1}</b>${o.itens.length > 1 ? `<button type="button" class="link-perigo" data-rem="${i}">Remover</button>` : ''}</div>
        <input name="it-desc" value="${esc(it.descricao)}" placeholder="Descrição do serviço" aria-label="Descrição do item ${i + 1}">
        <div class="tres">
          <div><label>Unid.</label><input name="it-un" value="${esc(it.un)}" placeholder="m², un, vb" aria-label="Unidade do item ${i + 1}"></div>
          <div><label>Qtd.</label><input name="it-qtd" inputmode="decimal" value="${it.qtd ? qtdTexto(it.qtd) : ''}" aria-label="Quantidade do item ${i + 1}"></div>
          ${ehMo()
            ? `<div><label>M. obra unit.</label><input name="it-mo" inputmode="decimal" value="${valorCampo(it.valorMo)}" placeholder="0,00" aria-label="Mão de obra por unidade, item ${i + 1}"></div>`
            : `<div><label>Valor unit.</label><input name="it-valor" inputmode="decimal" value="${valorCampo(it.valor)}" placeholder="0,00" aria-label="Valor por unidade, item ${i + 1}"></div>`}
        </div>
        ${ehMo() ? `<label>Material estimado por unidade (R$, referência)</label><input name="it-mat" inputmode="decimal" value="${valorCampo(it.valorMat)}" placeholder="0,00" aria-label="Material estimado por unidade, item ${i + 1}">` : ''}
        <small class="subtotal" data-sub="${i}"></small>
      </div>`).join('');
    $('#itens').querySelectorAll('[data-rem]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Remover o item ${Number(b.dataset.rem) + 1}?`)) return;
        await salvarAgora(); o.itens.splice(Number(b.dataset.rem), 1); await salvarAgora(true); desenharItens();
      };
    });
    mostrarTotais();
  };
  const lerItens = () => [...document.querySelectorAll('.item-orc')].map((el) => {
    const v = (n) => { const x = el.querySelector(`[name="${n}"]`); return x ? x.value : undefined; };
    const it = { ...(o.itens[Number(el.dataset.i)] || { id: novoId() }), descricao: v('it-desc'), un: v('it-un'), qtd: lerValor(v('it-qtd')) };
    if (v('it-valor') !== undefined) it.valor = lerValor(v('it-valor'));
    if (v('it-mo') !== undefined) it.valorMo = lerValor(v('it-mo'));
    if (v('it-mat') !== undefined) it.valorMat = lerValor(v('it-mat'));
    return it;
  });
  const mostrarTotais = () => {
    o.itens.forEach((it, i) => {
      const s = document.querySelector(`[data-sub="${i}"]`); if (!s) return;
      const q = Number(it.qtd) || 0;
      s.textContent = ehMo()
        ? `Mão de obra: ${moeda(q * (it.valorMo || 0))} · Material estimado: ${moeda(q * (it.valorMat || 0))}`
        : `Subtotal: ${moeda(q * (it.valor || 0))}`;
    });
    const t = totaisOrc(o), custo = Number(o.custoEstimado) || 0;
    const margem = custo && t.contrato ? `<div class="linha-total interno"><span>Margem estimada (só você vê)</span><b class="${t.contrato - custo < 0 ? 'alerta' : 'positivo'}">${moeda(t.contrato - custo)} · ${Math.round(((t.contrato - custo) / t.contrato) * 100)}%</b></div>` : '';
    $('#totais').innerHTML = ehMo() ? `
      <div class="linha-total"><span>Mão de obra (valor da proposta)</span><b>${moeda(t.mo)}</b></div>
      <div class="linha-total"><span>Material estimado (cliente compra)</span><b>${moeda(t.mat)}</b></div>
      <div class="linha-total"><span>Total estimado para o cliente</span><b>${moeda(t.mo + t.mat)}</b></div>${margem}` : `
      <div class="linha-total"><span>Valor total (material + mão de obra)</span><b>${moeda(t.contrato)}</b></div>${margem}`;
  };

  // ----- salvamento automático
  let timer;
  const salvarAgora = async (semLer) => {
    clearTimeout(timer); _salvarPendente = null;
    const d = { ...Object.fromEntries(new FormData($('#f-orc'))), ...Object.fromEntries(new FormData($('#f-orc2'))) };
    for (const k of Object.keys(d)) if (k.startsWith('it-')) delete d[k];
    d.validadeDias = parseInt(d.validadeDias, 10) || 15;
    d.custoEstimado = lerValor(d.custoEstimado);
    if (!semLer) o.itens = lerItens();
    Object.assign(o, d, { atualizadoEm: agora() });
    await gravar('orcamentos', o);
    mostrarTotais();
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    ['#salvo', '#salvo2'].forEach((s) => { if ($(s)) $(s).textContent = 'Salvo no aparelho ✓ ' + hora; });
  };
  const agendar = () => { clearTimeout(timer); _salvarPendente = salvarAgora; timer = setTimeout(salvarAgora, 700); };
  for (const f of ['#f-orc', '#f-orc2']) {
    $(f).addEventListener('input', agendar);
    $(f).addEventListener('change', agendar);
    $(f).addEventListener('submit', (e) => e.preventDefault());
  }
  $('#o-servico').addEventListener('input', (e) => { $('#t-orc').textContent = e.target.value || 'Nova vistoria'; });
  $('#o-situacao').addEventListener('change', (e) => {
    const s = e.target.value;
    $('#box-retorno').hidden = s !== 'Enviado';
    if (s === 'Enviado' && !$('#o-retornarEm').value) $('#o-retornarEm').value = maisDias(3);
    $('#st-orc').textContent = s; $('#st-orc').className = 'st st-' + slug(s);
  });
  // Trocar o fornecimento: aproveita os valores já digitados
  document.querySelectorAll('input[name="fornecimento"]').forEach((r) => {
    r.addEventListener('change', async () => {
      await salvarAgora();
      for (const it of o.itens) {
        if (o.fornecimento === 'mo' && !it.valorMo && !it.valorMat) it.valorMo = it.valor || 0;
        if (o.fornecimento !== 'mo' && !it.valor) it.valor = centavos((it.valorMo || 0) + (it.valorMat || 0));
      }
      await salvarAgora(true); desenharItens();
    });
  });
  $('#b-add-item').onclick = async () => {
    await salvarAgora();
    o.itens.push({ id: novoId(), descricao: '', un: '', qtd: 1, valor: 0, valorMo: 0, valorMat: 0 });
    await salvarAgora(true); desenharItens();
    const novos = document.querySelectorAll('[name="it-desc"]'); novos[novos.length - 1].focus();
  };

  desenharItens();
  if (!obra) await mostrarFotos({ id: o.id }, { id: o.id });

  // Fotos: cada uma ganha "Na proposta" (marcada = entra na proposta completa)
  const marcarFotos = async () => {
    const box = $('#fotos'); if (!box) return;
    for (const b of box.querySelectorAll('[data-remover]')) {
      if (b.parentElement.querySelector('.na-proposta')) continue;
      const f = await pegar('fotos', b.dataset.remover); if (!f) continue;
      const l = document.createElement('label'); l.className = 'na-proposta';
      l.innerHTML = `<input type="checkbox" ${f.foraDaProposta ? '' : 'checked'}> Na proposta`;
      l.querySelector('input').onchange = async (e) => {
        const x = await pegar('fotos', f.id); if (!x) return;
        x.foraDaProposta = !e.target.checked; x.atualizadoEm = agora(); await gravar('fotos', x);
      };
      b.before(l);
    }
  };
  if ($('#fotos')) { new MutationObserver(marcarFotos).observe($('#fotos'), { childList: true }); marcarFotos(); }

  const modelo = () => (document.querySelector('input[name="modelo-pdf"]:checked') || {}).value;
  const dicaModelo = () => {
    $('#dica-modelo').textContent = modelo() === 'completa'
      ? 'Capa, apresentação da V&M, escopo, fotos da vistoria marcadas "Na proposta", valores, condições, próximos passos e contato.'
      : 'Uma ou duas páginas: dados, escopo, valores e condições.';
  };
  document.querySelectorAll('input[name="modelo-pdf"]').forEach((r) => { r.onchange = dicaModelo; });
  dicaModelo();
  const gerador = async () => {
    await salvarAgora();
    const completa = modelo() === 'completa';
    const prob = conferirOrcamento(o, completa);
    if (prob.length) throw new Error('antes de gerar, ' + prob.join('; '));
    return completa ? gerarPropostaCompleta(o.id) : gerarPdfOrcamento(o.id);
  };
  $('#b-orc-enviar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'enviar', 'Proposta V&M Engenharia');
  $('#b-orc-baixar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'baixar', 'Proposta V&M Engenharia');
  if ($('#b-virar-obra')) $('#b-virar-obra').onclick = async () => { await salvarAgora(); transformarEmObra(o); };
  $('#b-excluir-orc').onclick = async () => {
    const fotos = await porIndice('fotos', 'visitaId', o.id);
    if (!confirm(`Excluir o orçamento "${o.servico || o.numero}"${fotos.length ? ` e ${fotos.length} foto(s)` : ''}? Isso não tem volta (a não ser por um backup).${obra ? '\n\nA obra criada a partir dele continua.' : ''}`)) return;
    clearTimeout(timer); _salvarPendente = null;
    for (const f of fotos) await excluir('fotos', f.id);
    await excluir('orcamentos', o.id);
    aviso('Orçamento excluído'); location.hash = '#/orcamentos';
  };
}

// ---------------------------------------------------------------- aprovado: vira obra
async function transformarEmObra(o) {
  const t = totaisOrc(o);
  if (!o.servico) { aviso('Preencha o "Serviço (título)": ele vira o nome da obra', 4000); $('#o-servico').focus(); return; }
  if (!confirm(`Transformar em obra?\n\nObra: ${o.servico}\nCliente: ${o.cliente || '-'}\nValor do contrato: ${moeda(t.contrato)}${o.custoEstimado ? `\nCusto previsto: ${moeda(o.custoEstimado)}` : ''}\n\nO orçamento fica como "Aprovado" e as fotos da vistoria vão para o diário da obra.`)) return;
  const obra = {
    id: novoId(), nome: o.servico, cliente: o.cliente, local: o.local, art: '', inicio: hoje(),
    valorContrato: t.contrato, custoPrevisto: Number(o.custoEstimado) || 0, situacao: 'Em andamento',
    orcamentoId: o.id, criadoEm: agora(), atualizadoEm: agora()
  };
  await gravar('obras', obra);
  const fotos = await porIndice('fotos', 'visitaId', o.id);
  if (fotos.length || o.necessidade) {
    const v = {
      id: novoId(), obraId: obra.id, data: o.data || hoje(), climaManha: '', climaTarde: '', condicao: '', equipe: '',
      atividades: ['Vistoria técnica inicial, antes do início da obra.', o.necessidade && `Necessidade levantada: ${o.necessidade}`].filter(Boolean).join('\n'),
      ocorrencias: '', orientacoes: '', criadoEm: agora(), atualizadoEm: agora()
    };
    await gravar('visitas', v);
    for (const f of fotos) await gravar('fotos', { ...f, visitaId: v.id, obraId: obra.id, legenda: f.legenda || 'Antes', atualizadoEm: agora() });
  }
  Object.assign(o, { situacao: 'Aprovado', obraId: obra.id, retornarEm: '', atualizadoEm: agora() });
  await gravar('orcamentos', o);
  _salvarPendente = null;
  aviso('Obra criada a partir do orçamento', 3500);
  location.hash = '#/obra/' + obra.id;
}

// ---------------------------------------------------------------- PDFs para o cliente
// Partes comuns do PDF simples e da proposta completa
function prepararPdfOrc(o) {
  const its = (o.itens || []).filter((it) => (it.descricao || '').trim() || it.valor || it.valorMo || it.valorMat);
  if (!its.length) throw new Error('inclua pelo menos um item no orçamento');
  const dias = Number(o.validadeDias) || 30;
  return { its, t: totaisOrc(o), mo: o.fornecimento === 'mo', validade: `${dias} dias (até ${dataBR(maisDias(dias))})` };
}

function pdfValores(P, o, its, t, mo) {
  const cols = (rotUnit, rotTotal) => [
    { t: 'Item', w: 11 }, { t: 'Descrição', w: 83 }, { t: 'Unid.', w: 14 }, { t: 'Qtd.', w: 16, a: 'right' },
    { t: rotUnit, w: 28, a: 'right' }, { t: rotTotal, w: 28, a: 'right', negrito: true }
  ];
  const linhas = (lista, campo) => lista.map((it, i) => [String(i + 1), it.descricao || '-', it.un || '', qtdTexto(it.qtd),
    moeda(it[campo]), moeda(centavos((Number(it.qtd) || 0) * (Number(it[campo]) || 0)))]);

  if (!mo) {
    P.titulo('Serviços e valores');
    P.tabela(cols('Valor unit.', 'Total'), linhas(its, 'valor'));
    P.y -= 2; P.total('VALOR TOTAL (MATERIAL E MÃO DE OBRA)', moeda(t.contrato));
    return;
  }
  P.titulo('Mão de obra');
  P.tabela(cols('Valor unit.', 'Total'), linhas(its, 'valorMo'));
  P.y -= 2; P.total('VALOR DA MÃO DE OBRA', moeda(t.mo));
  const mats = its.filter((it) => Number(it.valorMat) > 0);
  if (mats.length) {
    P.y += 3;
    P.titulo('Estimativa de materiais (por conta do cliente)');
    P.tabela(cols('Ref. unit.', 'Estimado'), linhas(mats, 'valorMat'));
    P.y -= 2; P.total('MATERIAL ESTIMADO (REFERÊNCIA)', moeda(t.mat), false);
    P.paragrafo('Valores de referência, estimados na data deste orçamento. A compra dos materiais é feita pelo cliente e os preços podem variar conforme o fornecedor e a data da compra. Este valor não faz parte do valor da proposta.', '', 9);
  }
}

function pdfCondicoes(P, o, validade, mo) {
  P.titulo('Condições');
  P.campo('Prazo de execução', o.prazo);
  P.campo('Forma de pagamento', (o.pagamento || '').trim() || PAGAMENTO_PADRAO);
  P.campo('Validade da proposta', validade);
  P.campo('Responsabilidade técnica', 'Emissão de ART conforme o serviço contratado, assumida mediante contratação formal.');
  P.campo('Garantia', `Limitada à mão de obra executada, em prazo definido conforme o tipo de serviço.${mo ? ' Os materiais comprados pelo cliente seguem a garantia do fabricante.' : ''}`);
  P.campo('Não incluso / observações', o.observacoes);
}

// 1) PDF simples (1 a 2 páginas)
async function gerarPdfOrcamento(id) {
  const o = await pegar('orcamentos', id);
  const { its, t, mo, validade } = prepararPdfOrc(o);
  const P = await criarPdf('ORÇAMENTO', `nº ${o.numero || ''}  ·  ${o.servico || ''}  ·  ${dataBR(hoje())}`);
  P.quadro([
    ['Cliente', o.cliente], ['Local', o.local], ['Serviço', o.servico],
    ['Vistoria técnica', dataBR(o.data)], ['Fornecimento', mo ? 'Mão de obra (material por conta do cliente)' : 'Material e mão de obra'],
    ['Data do orçamento', dataBR(hoje())], ['Validade', validade]
  ]);
  if ((o.necessidade || '').trim()) { P.titulo('Escopo do serviço'); P.paragrafo(o.necessidade); }
  pdfValores(P, o, its, t, mo);
  pdfCondicoes(P, o, validade, mo);
  P.assinatura(hoje());
  return P.finalizar(`Orcamento-${o.numero || ''}-${slug(o.cliente || o.servico)}.pdf`);
}

// 2) Proposta completa: capa, apresentação, escopo, fotos da vistoria, valores, condições, próximos passos e contato
async function gerarPropostaCompleta(id) {
  const o = await pegar('orcamentos', id);
  const { its, t, mo, validade } = prepararPdfOrc(o);
  const fotos = (await porIndice('fotos', 'visitaId', o.id)).filter((f) => !f.foraDaProposta).sort((a, b) => a.ordem - b.ordem);

  const P = await criarPdf('PROPOSTA TÉCNICA E COMERCIAL', `nº ${o.numero || ''}  ·  ${o.servico || ''}  ·  ${o.cliente || ''}`);
  const { doc, W, H, M } = P;

  // ----- capa (página 1): faixa azul-marinho com o logo e o título; dados embaixo
  doc.setFillColor(255, 255, 255); doc.rect(0, 0, W, H, 'F');
  doc.setFillColor(...COR.NAVY); doc.rect(0, 0, W, 196, 'F');
  doc.addImage(await logoDataUrl(), 'PNG', (W - 46) / 2, 36, 46, 47.6, 'logo', 'FAST');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(184, 199, 214);
  doc.text('ENGENHARIA CIVIL  ·  CURITIBA/PR', W / 2, 96, { align: 'center' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(21); doc.setTextColor(241, 245, 249);
  doc.text('PROPOSTA TÉCNICA E COMERCIAL', W / 2, 124, { align: 'center' });
  doc.setFontSize(15); doc.setTextColor(...COR.AZUL);
  let y = 137;
  for (const l of doc.splitTextToSize(pdfTxt(o.servico), 160).slice(0, 3)) { doc.text(l, W / 2, y, { align: 'center' }); y += 7; }
  doc.setDrawColor(...COR.AZUL); doc.setLineWidth(0.8); doc.line(W / 2 - 14, y, W / 2 + 14, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(184, 199, 214);
  doc.text(pdfTxt(`Proposta nº ${o.numero || ''}  ·  ${dataExtenso(hoje())}`), W / 2, y + 12, { align: 'center' });

  const bloco = (x, yy, rot, val) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...COR.CINZA); doc.text(rot, x, yy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11.5); doc.setTextColor(...COR.NAVY);
    doc.splitTextToSize(pdfTxt(val), 82).slice(0, 2).forEach((l, i) => doc.text(l, x, yy + 6 + i * 5.2));
  };
  bloco(M, 214, 'PARA', o.cliente);
  bloco(110, 214, 'RESPONSÁVEL TÉCNICO', `${EMPRESA.resp}, Engenheiro Civil · ${EMPRESA.crea}`);
  bloco(M, 240, 'LOCAL DA OBRA', o.local || '-');
  bloco(110, 240, 'VALIDADE DA PROPOSTA', validade);
  doc.addPage(); P.cabecalho();

  // ----- conteúdo
  P.titulo('Apresentação');
  P.paragrafo(`A ${EMPRESA.nome} é uma empresa de engenharia civil de Curitiba/PR. Atua em obras residenciais, reformas, calhas e telhados, projetos, regularização de imóveis, laudos técnicos e acompanhamento de obras. Os serviços são conduzidos pelo ${EMPRESA.resp}, engenheiro civil (${EMPRESA.crea}).`);
  P.paragrafo(`Esta proposta foi preparada para ${o.cliente}${o.local ? `, para o imóvel em ${o.local}` : ''}, a partir da vistoria técnica${o.data ? ` realizada em ${dataBR(o.data)}` : ''}.`);

  P.titulo('Escopo do serviço');
  P.paragrafo(o.necessidade);
  P.campo('Fornecimento', mo ? 'Mão de obra. Os materiais são comprados pelo cliente; a estimativa de materiais vem como referência.' : 'Material e mão de obra.');

  if (fotos.length) {
    P.titulo(`Registro da vistoria técnica (${fotos.length} foto${fotos.length > 1 ? 's' : ''})`);
    await P.fotos(fotos, { colunas: fotos.length === 1 ? 2 : 3, maxH: fotos.length === 1 ? 68 : 44, reduzir: 1000 });
    P.y += 2;
  }

  pdfValores(P, o, its, t, mo);
  pdfCondicoes(P, o, validade, mo);

  P.titulo('Próximos passos');
  P.paragrafo([
    '1. Aprovação da proposta, por WhatsApp ou e-mail.',
    '2. Alinhamento da data de início e formalização da contratação.',
    '3. Emissão da ART e início dos serviços, com acompanhamento técnico do engenheiro responsável.'
  ].join('\n'));

  P.titulo('Contato');
  P.paragrafo([
    `WhatsApp: ${CONTATO.whatsapp}`, `E-mail: ${CONTATO.email}`, `Instagram: ${CONTATO.instagram}`,
    `Site: ${CONTATO.site}`, `Endereço: ${CONTATO.endereco}`
  ].join('\n'));
  P.assinatura(hoje());
  return P.finalizar(`Proposta-${o.numero || ''}-${slug(o.cliente || o.servico)}.pdf`);
}
