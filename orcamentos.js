'use strict';
// Orçamentos: vistoria técnica -> orçamento -> enviado -> aprovado/recusado -> "Transformar em obra".
// Usa as funções do app.js (banco, telas, PDF). Fotos da vistoria ficam na loja "fotos"
// com visitaId = obraId = id do orçamento; ao virar obra, passam para a primeira visita da obra.

const SITUACOES_ORC = ['Vistoria', 'Orçando', 'Enviado', 'Aprovado', 'Recusado'];
const FORNECIMENTO = {
  global: 'Material e mão de obra',
  mo: 'Só mão de obra (material por conta do cliente)'
};
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
      prazo: '', pagamento: '', validadeDias: 15, observacoes: '', custoEstimado: 0, retornarEm: '',
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
      ${area('pagamento', 'Forma de pagamento', 'Ex.: 40% na assinatura, 60% na conclusão · Pix')}
      <div class="duas">
        <div>${txt('validadeDias', 'Validade da proposta (dias)', '15', 'number', 'min="1" inputmode="numeric"')}</div>
        <div>${txt('custoEstimado', 'Seu custo estimado (R$)', '0,00', 'text', 'inputmode="decimal"')}</div>
      </div>
      <p class="sub" style="margin:.3rem 0 0">O custo estimado é só para você (não vai no PDF): no "Só mão de obra", coloque só o que você vai gastar (mão de obra), sem o material do cliente. Ao virar obra, ele vira o "custo previsto".</p>
      ${area('observacoes', 'Observações para o cliente (vai no PDF)', 'Ex.: Não inclui pintura. Entulho por conta do cliente.')}
      <p class="salvo" id="salvo2"></p>
    </form>

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

  const gerador = async () => { await salvarAgora(); return gerarPdfOrcamento(o.id); };
  $('#b-orc-enviar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'enviar', 'Orçamento V&M Engenharia');
  $('#b-orc-baixar').onclick = (e) => acaoPdf(e.currentTarget, gerador, 'baixar', 'Orçamento V&M Engenharia');
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

// ---------------------------------------------------------------- PDF do orçamento (para o cliente)
async function gerarPdfOrcamento(id) {
  const o = await pegar('orcamentos', id);
  const t = totaisOrc(o);
  const mo = o.fornecimento === 'mo';
  const its = (o.itens || []).filter((it) => (it.descricao || '').trim() || it.valor || it.valorMo || it.valorMat);
  if (!its.length) throw new Error('inclua pelo menos um item no orçamento');
  const dias = Number(o.validadeDias) || 15;
  const validade = `${dias} dias (até ${dataBR(maisDias(dias))})`;

  const P = await criarPdf('ORÇAMENTO', `nº ${o.numero || ''}  ·  ${o.servico || ''}  ·  ${dataBR(hoje())}`);
  P.quadro([
    ['Cliente', o.cliente], ['Local', o.local], ['Serviço', o.servico],
    ['Vistoria técnica', dataBR(o.data)], ['Fornecimento', mo ? 'Mão de obra (material por conta do cliente)' : 'Material e mão de obra'],
    ['Data do orçamento', dataBR(hoje())], ['Validade', validade]
  ]);
  if ((o.necessidade || '').trim()) { P.titulo('Escopo do serviço'); P.paragrafo(o.necessidade); }

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
  } else {
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

  P.titulo('Condições');
  P.campo('Prazo de execução', o.prazo);
  P.campo('Forma de pagamento', o.pagamento);
  P.campo('Validade da proposta', validade);
  P.campo('Responsabilidade técnica', 'Emissão de ART conforme o serviço contratado.');
  P.campo('Observações', o.observacoes);
  P.assinatura(hoje());
  return P.finalizar(`Orcamento-${o.numero || ''}-${slug(o.cliente || o.servico)}.pdf`);
}
