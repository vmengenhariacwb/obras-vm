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

// ---------------------------------------------------------------- valor global e modelos
// Campo do valor que vai para o cliente: "valor" (material + MO) ou "valorMo" (só mão de obra)
const campoValor = (o) => (o.fornecimento === 'mo' ? 'valorMo' : 'valor');
const totalItem = (it, campo) => centavos((Number(it.qtd) || 0) * (Number(it[campo]) || 0));

// Reparte "total" na proporção dos pesos (pesos zerados = partes iguais).
// Arredonda em reais quando o total é redondo; o maior item fica com a diferença do arredondamento.
function repartir(total, pesos) {
  total = centavos(total);
  if (!pesos.length) return [];
  let p = pesos.map((x) => Math.max(0, Number(x) || 0));
  let s = p.reduce((a, b) => a + b, 0);
  if (!s) { p = p.map(() => 1); s = p.length; }
  const passo = Number.isInteger(total) && total >= p.length * 10 ? 1 : 0.01;
  const v = p.map((x) => centavos(Math.round((total * x) / s / passo) * passo));
  const dif = centavos(total - v.reduce((a, b) => a + b, 0));
  const iMaior = v.indexOf(Math.max(...v));
  v[iMaior] = centavos(v[iMaior] + dif);
  return v;
}
// Grava o total de cada item como valor unitário (total ÷ quantidade) e acerta a diferença num item de qtd. 1.
// Valores redondos: o unitário também fica em reais inteiros (ex.: R$ 65,00/m², não R$ 64,99).
function aplicarTotais(itens, tots, campo) {
  const redondo = tots.every((t) => Number.isInteger(t));
  itens.forEach((it, i) => {
    if (!(Number(it.qtd) > 0)) it.qtd = 1;
    const u = tots[i] / Number(it.qtd);
    it[campo] = redondo && u >= 10 ? Math.round(u) : centavos(u);
  });
  const dif = centavos(tots.reduce((a, b) => a + b, 0) - itens.reduce((s, it) => s + totalItem(it, campo), 0));
  if (dif) {
    const um = itens.filter((it) => Number(it.qtd) === 1).sort((a, b) => b[campo] - a[campo])[0];
    if (um) um[campo] = centavos(um[campo] + dif);
  }
}
// Com valor global combinado: os itens que você não mexeu à mão se ajustam para o total fechar
function fecharNoGlobal(o) {
  const g = Number(o.valorGlobal) || 0;
  if (!g) return;
  const campo = campoValor(o);
  const livres = o.itens.filter((it) => !it.fixo);
  if (!livres.length) return;
  const resto = centavos(g - o.itens.filter((it) => it.fixo).reduce((s, it) => s + totalItem(it, campo), 0));
  if (resto < 0) return;
  aplicarTotais(livres, repartir(resto, livres.map((it) => totalItem(it, campo))), campo);
}

// Modelos iniciais (só a divisão em %, sem preços). Ficam no aparelho e sincronizam pelo Drive;
// dá para editar, apagar e criar novos. Os ids fixos evitam duplicar entre o celular e o PC.
const MODELOS_PADRAO = [
  {
    id: 'modelo-telhado-ripas', nome: 'Reforma de telhado cerâmico (troca de ripas)',
    itens: [
      ['Mobilização, andaime e proteção dos ambientes', 5],
      ['Retirada e recolocação das telhas cerâmicas (com reposição das quebradas)', 25],
      ['Substituição das ripas', 30],
      ['Substituição pontual de caibros e terças', 15],
      ['Recolocação e emboçamento da cumeeira', 5],
      ['Transporte do entulho até a caçamba e limpeza', 5],
      ['Engenharia, acompanhamento técnico e ART', 15]
    ],
    escopo: 'Reforma do telhado cerâmico, com retirada das telhas, substituição das ripas, substituição pontual de peças do madeiramento comprometidas e recolocação das telhas, conforme constatado na vistoria técnica.',
    observacoes: 'Não incluso: reparo de forro e pintura interna, revisão de calhas e condutores, locação de caçamba.'
  },
  {
    id: 'modelo-telhado-completo', nome: 'Troca completa de telhado',
    itens: [
      ['Mobilização, andaime e proteção dos ambientes', 5],
      ['Retirada das telhas e do madeiramento existente', 12],
      ['Estrutura de madeira nova (tesouras, terças, caibros e ripas)', 30],
      ['Instalação das telhas novas', 25],
      ['Cumeeiras, rufos e arremates', 8],
      ['Transporte do entulho até a caçamba e limpeza', 5],
      ['Engenharia, acompanhamento técnico e ART', 15]
    ],
    escopo: 'Troca completa do telhado, com retirada das telhas e do madeiramento existente, execução de estrutura de madeira nova, instalação das telhas novas e arremates (cumeeiras e rufos).',
    observacoes: 'Não incluso: forro, pintura, calhas e condutores, locação de caçamba.'
  },
  {
    id: 'modelo-calhas', nome: 'Troca de calhas e condutores',
    itens: [
      ['Mobilização e andaime', 10],
      ['Retirada das calhas e condutores existentes', 15],
      ['Instalação das calhas novas', 40],
      ['Instalação dos condutores', 20],
      ['Vedação, teste de escoamento e limpeza', 5],
      ['Engenharia, acompanhamento técnico e ART', 10]
    ],
    escopo: 'Substituição das calhas e condutores, com retirada dos existentes, instalação dos novos, vedação das emendas e teste de escoamento.',
    observacoes: ''
  },
  {
    id: 'modelo-banheiro', nome: 'Reforma de banheiro',
    itens: [
      ['Demolição de revestimentos e louças, com retirada do entulho', 12],
      ['Instalações hidráulicas e de esgoto', 18],
      ['Impermeabilização do piso e do box', 10],
      ['Contrapiso e regularização', 8],
      ['Assentamento de revestimento de piso e parede', 30],
      ['Instalação de louças, metais e acessórios', 8],
      ['Limpeza final', 4],
      ['Engenharia, acompanhamento técnico e ART', 10]
    ],
    escopo: 'Reforma do banheiro, com demolição dos revestimentos, revisão das instalações hidráulicas e de esgoto, impermeabilização, novo revestimento de piso e parede e instalação de louças e metais.',
    observacoes: 'Não incluso: forro, pintura, elétrica e móveis.'
  },
  {
    id: 'modelo-piso', nome: 'Assentamento de piso / porcelanato',
    itens: [
      ['Retirada do piso existente e do entulho', 15],
      ['Regularização do contrapiso', 15],
      ['Assentamento do piso', 55],
      ['Rejuntamento e limpeza', 10],
      ['Acompanhamento técnico', 5]
    ],
    escopo: 'Troca do piso, com retirada do revestimento existente, regularização do contrapiso, assentamento do novo piso, rejuntamento e limpeza.',
    observacoes: 'Não incluso: rodapés, pintura e móveis.'
  },
  {
    id: 'modelo-pintura', nome: 'Pintura',
    itens: [
      ['Proteção dos ambientes e preparação', 10],
      ['Raspagem, lixamento e correções', 20],
      ['Emassamento', 20],
      ['Pintura acrílica (2 demãos)', 40],
      ['Limpeza final', 5],
      ['Acompanhamento técnico', 5]
    ],
    escopo: 'Pintura dos ambientes, com proteção, preparação das superfícies (raspagem, lixamento e correções), emassamento e pintura em duas demãos.',
    observacoes: ''
  },
  {
    id: 'modelo-regularizacao', nome: 'Regularização de imóvel',
    itens: [
      ['Levantamento técnico no imóvel', 20],
      ['Elaboração das plantas e documentos técnicos', 45],
      ['Protocolo e acompanhamento junto à Prefeitura', 25],
      ['Emissão de ART', 10]
    ],
    escopo: 'Regularização do imóvel junto à Prefeitura, com levantamento técnico, elaboração das plantas e documentos técnicos, protocolo e acompanhamento do processo.',
    observacoes: 'Não incluso: taxas e emolumentos da Prefeitura e do cartório.'
  }
];
async function garantirModelos() {
  const lapides = new Set((await todos('excluidos')).map((e) => e.id));
  const desde = '2026-11-23T00:00:00.000Z';   // data antiga: qualquer edição sua vale mais que o modelo inicial
  for (const m of MODELOS_PADRAO) {
    if (lapides.has(m.id) || (await pegar('modelos', m.id))) continue;
    await tx('modelos', 'readwrite', (s) => s.put({
      ...m, itens: m.itens.map(([descricao, peso]) => ({ descricao, peso })), criadoEm: desde, atualizadoEm: desde
    }));
  }
}
const somaPesos = (m) => Math.round((m.itens || []).reduce((s, x) => s + (Number(x.peso) || 0), 0) * 10) / 10;
const porNome = (a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR');

// ---------------------------------------------------------------- lista
async function telaOrcamentos(main) {
  await garantirModelos();
  const nModelos = (await todos('modelos')).length;
  const os =(await todos('orcamentos')).sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || ''));
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
    <a class="item lanc" href="#/ia" style="margin-bottom:.6rem"><span><strong>IA do app</strong>
      <small>${chaveIA() ? 'Ligada neste aparelho · ' + esc(IA_MODELOS[modeloIA()].nome.split(' (')[0]) : 'Desligada neste aparelho: toque para colocar a chave'}</small></span>
      <span class="valor"><small>${textoGasto(gastoMes().usd)} no mês</small></span></a>
    <a class="item lanc" href="#/modelos" style="margin-bottom:.4rem"><span><strong>Modelos de orçamento</strong>
      <small>Itens prontos por tipo de serviço, com a % de cada um para repartir o valor global</small></span>
      <span class="valor"><b>${nModelos}</b></span></a>
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
  await garantirModelos();
  const modelos = (await todos('modelos')).sort(porNome);
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

    <div class="card ia-card" style="margin-top:1rem">
      <h2 style="margin-top:0">Montar com IA</h2>
      <label for="ia-pedido">Descreva o serviço do seu jeito (dá para ditar no microfone do teclado)</label>
      <textarea id="ia-pedido" placeholder="Ex.: troca de 80 m² de telha cerâmica, casa térrea, calha nova na frente, só mão de obra, valor global 18 mil.&#10;Para ajustar depois: &quot;tira a calha e põe pintura do beiral&quot;."></textarea>
      <div class="botoes lado">
        <button class="btn" id="b-ia-montar" type="button">Montar orçamento com IA</button>
        <a class="btn sec" href="#/ia">IA do app (chave e tabela)</a>
      </div>
      <p class="sub" id="ia-status" style="margin:.5rem 0 0">${chaveIA() ? `Usa a IA ${esc(IA_MODELOS[modeloIA()].nome.split(' (')[0])}, a vistoria acima, sua tabela de preços e seus últimos orçamentos. Você confere tudo antes de enviar.` : 'Para usar, guarde a chave da IA neste aparelho em "IA do app".'}</p>
      <div id="ia-avisos"></div>
    </div>

    <form id="f-orc2" class="card" autocomplete="off" style="margin-top:1rem">
      <h2 style="margin-top:0">2. Orçamento</h2>
      <label>Fornecimento</label>
      <div class="segmento" role="radiogroup" aria-label="Fornecimento">
        <label><input type="radio" name="fornecimento" value="global" ${o.fornecimento !== 'mo' ? 'checked' : ''}><span>Material + mão de obra</span></label>
        <label><input type="radio" name="fornecimento" value="mo" ${o.fornecimento === 'mo' ? 'checked' : ''}><span>Só mão de obra</span></label>
      </div>
      <p class="sub" id="dica-forn" style="margin:.5rem 0 0"></p>
      <details class="card rapido">
        <summary><b>Sem IA: modelo + valor global</b></summary>
        <label for="r-modelo">Modelo</label>
        <select id="r-modelo">
          <option value="">Repartir entre os itens abaixo</option>
          ${modelos.map((m) => `<option value="${esc(m.id)}">${esc(m.nome)}</option>`).join('')}
        </select>
        <label for="r-global">Valor global (R$)</label>
        <input id="r-global" inputmode="decimal" placeholder="Ex.: 18.000,00" value="${valorCampo(o.valorGlobal)}">
        <div class="botoes lado">
          <button class="btn" id="b-repartir" type="button">Repartir o valor</button>
          <a class="btn sec" href="#/modelos">Editar modelos</a>
        </div>
        <p class="sub" id="dica-rapido" style="margin:.5rem 0 0"></p>
      </details>
      <div id="itens"></div>
      <div class="botoes lado">
        <button class="btn sec" id="b-add-item" type="button">+ Adicionar item</button>
        <button class="btn sec" id="b-salvar-modelo" type="button">Salvar como modelo</button>
      </div>
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
        await salvarAgora(); o.itens.splice(Number(b.dataset.rem), 1); fecharNoGlobal(o); await salvarAgora(true); desenharItens();
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
    const comGlobal = Number(o.valorGlobal) > 0;
    o.itens.forEach((it, i) => {
      const s = document.querySelector(`[data-sub="${i}"]`); if (!s) return;
      const q = Number(it.qtd) || 0;
      s.textContent = (ehMo()
        ? `Mão de obra: ${moeda(q * (it.valorMo || 0))} · Material estimado: ${moeda(q * (it.valorMat || 0))}`
        : `Subtotal: ${moeda(q * (it.valor || 0))}`) + (comGlobal && it.fixo ? ' · valor fixado por você' : '');
    });
    const t = totaisOrc(o), custo = Number(o.custoEstimado) || 0;
    const dif = comGlobal ? centavos(o.valorGlobal - (ehMo() ? t.mo : t.contrato)) : 0;
    const global = comGlobal ? `<div class="linha-total interno"><span>Valor global combinado</span><b class="${dif ? 'alerta' : 'positivo'}">${moeda(o.valorGlobal)}${dif > 0 ? ` · faltam ${moeda(dif)}` : dif < 0 ? ` · passou ${moeda(-dif)}` : ' ✓'}</b></div>` : '';
    $('#dica-rapido').innerHTML = comGlobal
      ? `Valor global <b>${moeda(o.valorGlobal)}</b>: se você mudar o valor de um item, os outros se ajustam para o total continuar fechando. Para repartir tudo de novo, toque em "Repartir o valor".`
      : 'Escolha um modelo (ou use os itens abaixo), digite o valor global e toque em "Repartir o valor". Cada item fica como verba (1 vb); preencha a quantidade só se quiser mostrar, por exemplo, os m².';
    const margem = custo && t.contrato ? `<div class="linha-total interno"><span>Margem estimada (só você vê)</span><b class="${t.contrato - custo < 0 ? 'alerta' : 'positivo'}">${moeda(t.contrato - custo)} · ${Math.round(((t.contrato - custo) / t.contrato) * 100)}%</b></div>` : '';
    $('#totais').innerHTML = ehMo() ? `
      <div class="linha-total"><span>Mão de obra (valor da proposta)</span><b>${moeda(t.mo)}</b></div>
      <div class="linha-total"><span>Material estimado (cliente compra)</span><b>${moeda(t.mat)}</b></div>
      <div class="linha-total"><span>Total estimado para o cliente</span><b>${moeda(t.mo + t.mat)}</b></div>${global}${margem}` : `
      <div class="linha-total"><span>Valor total (material + mão de obra)</span><b>${moeda(t.contrato)}</b></div>${global}${margem}`;
  };
  // Atualiza só os campos de valor (sem redesenhar, para não tirar o cursor de onde você está)
  const atualizarValores = () => {
    const campo = campoValor(o);
    document.querySelectorAll('.item-orc').forEach((el) => {
      const it = o.itens[Number(el.dataset.i)]; if (!it) return;
      const inp = el.querySelector(ehMo() ? '[name="it-mo"]' : '[name="it-valor"]');
      if (inp) inp.value = valorCampo(it[campo]);
    });
    mostrarTotais();
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

  // ----- valor global: modelo (ou itens atuais) + valor -> reparte nos itens
  $('#b-repartir').onclick = async () => {
    const global = lerValor($('#r-global').value);
    if (!(global > 0)) { aviso('Digite o valor global', 3000); $('#r-global').focus(); return; }
    await salvarAgora();
    const campo = campoValor(o);
    const m = modelos.find((x) => x.id === $('#r-modelo').value);
    if (m) {
      const temItens = o.itens.some((it) => (it.descricao || '').trim() || Number(it[campo]) > 0);
      if (temItens && !confirm(`Trocar os itens atuais pelos ${m.itens.length} itens do modelo "${m.nome}"?`)) return;
      o.itens = m.itens.map((x) => ({ id: novoId(), descricao: x.descricao, un: 'vb', qtd: 1, valor: 0, valorMo: 0, valorMat: 0 }));
      aplicarTotais(o.itens, repartir(global, m.itens.map((x) => x.peso)), campo);
      // Textos do modelo entram nos campos vazios ou que vieram de outro modelo (o que você escreveu à mão fica)
      const deModelo = new Set(modelos.flatMap((x) => [x.nome, x.escopo, x.observacoes]).filter(Boolean).map((s) => s.trim()));
      const preencher = (campoForm, valor) => {
        const el = $('#o-' + campoForm);
        if (!el) return;
        if (deModelo.has(el.value.trim())) el.value = valor || '';
        else if (!el.value.trim() && valor) el.value = valor;
      };
      preencher('servico', m.nome); preencher('necessidade', m.escopo); preencher('observacoes', m.observacoes);
      $('#t-orc').textContent = $('#o-servico').value || 'Nova vistoria';
    } else {
      const its = o.itens.filter((it) => (it.descricao || '').trim());
      if (!its.length) { aviso('Escolha um modelo ou escreva os itens primeiro', 3500); return; }
      o.itens = its;
      aplicarTotais(its, repartir(global, its.map((it) => totalItem(it, campo))), campo);
    }
    o.itens.forEach((it) => { delete it.fixo; });
    o.valorGlobal = global;
    await salvarAgora(true); desenharItens();
    aviso('Valor repartido nos itens. Confira e ajuste se quiser.', 3500);
  };
  // ----- IA: descreve o serviço -> a IA devolve o orçamento completo; o app confere a soma e as frases
  $('#ia-pedido').value = o.pedidoIA || '';
  $('#ia-pedido').addEventListener('input', (e) => { o.pedidoIA = e.target.value; agendar(); });
  $('#b-ia-montar').onclick = async (e) => {
    const b = e.currentTarget, pedido = $('#ia-pedido').value.trim();
    if (!chaveIA()) { aviso('Primeiro guarde a chave da IA neste aparelho', 3500); location.hash = '#/ia'; return; }
    if (!pedido) { aviso('Descreva o serviço primeiro', 3000); $('#ia-pedido').focus(); return; }
    await salvarAgora();
    const substitui = o.itens.some((it) => (it.descricao || '').trim()) || (o.necessidade || '').trim();
    b.disabled = true; b.textContent = 'Montando... (até 1 minuto)';
    $('#ia-avisos').innerHTML = '';
    try {
      const { r, usd } = await montarComIA(o, pedido);
      if (substitui && !confirm('A IA montou o orçamento. Usar o que ela fez?\n\nSubstitui título, escopo, itens, prazo e observações. As medidas e anotações e as fotos continuam como estão.')) return;
      const forn = r.fornecimento === 'mo' ? 'mo' : 'global';
      o.fornecimento = forn;
      document.querySelector(`input[name="fornecimento"][value="${forn}"]`).checked = true;
      const campo = campoValor(o);
      o.itens = r.itens.map((x) => ({
        id: novoId(), descricao: String(x.descricao || '').trim(), un: String(x.un || 'vb').trim(),
        qtd: Number(x.qtd) > 0 ? Number(x.qtd) : 1, valor: 0, valorMo: 0,
        valorMat: forn === 'mo' ? centavos(Number(x.material_unit) || 0) : 0,
        [campo]: centavos(Number(x.valor_unit) || 0)
      }));
      // Valor global pedido: o app reparte na proporção que a IA sugeriu e garante a soma exata
      const g = centavos(Number(r.valor_global) || 0);
      o.valorGlobal = g > 0 ? g : 0;
      if (g > 0) aplicarTotais(o.itens, repartir(g, o.itens.map((it) => totalItem(it, campo))), campo);
      const por = (id, v) => { const el = $('#o-' + id); if (el && typeof v === 'string') el.value = v.trim(); };
      por('servico', r.servico); por('necessidade', r.escopo); por('prazo', r.prazo); por('observacoes', r.observacoes);
      $('#t-orc').textContent = $('#o-servico').value || 'Nova vistoria';
      await salvarAgora(true); desenharItens();
      $('#r-global').value = valorCampo(o.valorGlobal);
      const avisos = [...(r.avisos || []), ...conferirOrcamento(o, false).map((p) => 'Conferir: ' + p)];
      $('#ia-avisos').innerHTML = `<div class="ia-avisos">
        ${avisos.length ? `<b>Avisos da IA (só para você)</b><ul>${avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<b>A IA não deixou avisos.</b>'}
        <small>Custo deste pedido: ${textoGasto(usd)}. Confira os itens e os valores abaixo antes de enviar.</small></div>`;
      aviso('Orçamento montado. Confira antes de enviar.', 4000);
    } catch (err) {
      $('#ia-avisos').innerHTML = `<div class="ia-avisos erro"><b>Não deu certo:</b> ${esc(err.message)}</div>`;
    } finally { b.disabled = false; b.textContent = 'Montar orçamento com IA'; }
  };
  // Mexeu no valor de um item com global combinado: esse item fica fixo e os outros se ajustam.
  // Mexeu na quantidade: o total do item continua o mesmo (o valor unitário é recalculado).
  $('#itens').addEventListener('change', (e) => {
    const nome = e.target.name;
    if (!['it-valor', 'it-mo', 'it-qtd'].includes(nome) || !(Number(o.valorGlobal) > 0)) return;
    const i = Number(e.target.closest('.item-orc').dataset.i);
    const campo = campoValor(o);
    const antes = o.itens[i] ? totalItem(o.itens[i], campo) : 0;
    o.itens = lerItens();
    const it = o.itens[i];
    if (nome === 'it-qtd') { if (Number(it.qtd) > 0 && antes) it[campo] = centavos(antes / Number(it.qtd)); }
    else it.fixo = true;
    fecharNoGlobal(o);
    atualizarValores();
    salvarAgora(true);
  });
  $('#b-salvar-modelo').onclick = async () => {
    await salvarAgora();
    const campo = campoValor(o);
    const its = o.itens.filter((it) => (it.descricao || '').trim());
    if (!its.length) { aviso('Escreva os itens antes de salvar como modelo', 3500); return; }
    const nome = prompt('Nome do modelo:', o.servico || '');
    if (!nome || !nome.trim()) return;
    const tots = its.map((it) => totalItem(it, campo)), soma = tots.reduce((a, b) => a + b, 0);
    // % com uma casa decimal; o maior item fica com o arredondamento, para fechar 100% certinho
    const pesos = its.map((it, k) => (soma ? Math.round((tots[k] / soma) * 1000) / 10 : Math.round(1000 / its.length) / 10));
    const iMaior = pesos.indexOf(Math.max(...pesos));
    pesos[iMaior] = Math.round((pesos[iMaior] + 100 - pesos.reduce((a, b) => a + b, 0)) * 10) / 10;
    const m = {
      id: novoId(), nome: nome.trim(),
      itens: its.map((it, k) => ({ descricao: it.descricao.trim(), peso: pesos[k] })),
      escopo: o.necessidade || '', observacoes: o.observacoes || '', criadoEm: agora(), atualizadoEm: agora()
    };
    await gravar('modelos', m);
    modelos.push(m); modelos.sort(porNome);
    $('#r-modelo').insertAdjacentHTML('beforeend', `<option value="${esc(m.id)}">${esc(m.nome)}</option>`);
    aviso(`Modelo "${m.nome}" salvo (${soma ? 'com a % de cada item' : 'em partes iguais'})`, 3500);
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

// ---------------------------------------------------------------- modelos de orçamento
async function telaModelos(main) {
  await garantirModelos();
  const ms = (await todos('modelos')).sort(porNome);
  main.innerHTML = `
    <a class="voltar" href="#/orcamentos">‹ Orçamentos</a>
    <h1>Modelos de orçamento</h1>
    <p class="sub">Cada modelo tem os itens de um tipo de serviço e a % de cada um. No orçamento, você escolhe o modelo,
      digita o valor global e o app reparte. Também dá para salvar um orçamento pronto como modelo.</p>
    ${ms.length ? `<ul class="lista">${ms.map((m) => `<li><a class="item lanc" href="#/modelo/${esc(m.id)}">
      <span><strong>${esc(m.nome)}</strong><small>${(m.itens || []).length} itens</small></span>
      <span class="valor"><small class="${somaPesos(m) === 100 ? '' : 'alerta'}">${somaPesos(m).toLocaleString('pt-BR')}%</small></span>
    </a></li>`).join('')}</ul>` : '<p class="vazio">Nenhum modelo. Toque em <b>+ Novo modelo</b>.</p>'}
    <button class="btn flutuante" id="b-novo-modelo" type="button">+ Novo modelo</button>`;
  $('#b-novo-modelo').onclick = async () => {
    const m = { id: novoId(), nome: '', itens: [{ descricao: '', peso: 100 }], escopo: '', observacoes: '', criadoEm: agora(), atualizadoEm: agora() };
    await gravar('modelos', m);
    location.hash = '#/modelo/' + m.id;
  };
}

async function telaModelo(main, id) {
  const m = await pegar('modelos', id);
  if (!m) { location.hash = '#/modelos'; return; }
  m.itens = m.itens || [];
  main.innerHTML = `
    <a class="voltar" href="#/modelos">‹ Modelos</a>
    <h1 id="t-modelo">${esc(m.nome || 'Novo modelo')}</h1>
    <form id="f-modelo" class="card" autocomplete="off">
      <label for="m-nome">Nome do modelo (vira o título do serviço)</label>
      <input id="m-nome" name="nome" value="${esc(m.nome)}" placeholder="Ex.: Troca de telhado">
      <h2>Itens e % do valor global</h2>
      <div id="m-itens"></div>
      <p class="sub" id="m-soma" style="margin:.6rem 0 0"></p>
      <div class="botoes"><button class="btn sec" id="b-m-add" type="button">+ Adicionar item</button></div>
      <label for="m-escopo">Escopo padrão (entra no orçamento se o escopo estiver vazio)</label>
      <textarea id="m-escopo" name="escopo">${esc(m.escopo)}</textarea>
      <label for="m-obs">Observações padrão (ex.: o que não está incluso)</label>
      <textarea id="m-obs" name="observacoes">${esc(m.observacoes)}</textarea>
      <p class="salvo" id="salvo"></p>
    </form>
    <div class="botoes"><button class="btn perigo" id="b-excluir-modelo" type="button">Excluir modelo</button></div>`;

  const desenhar = () => {
    $('#m-itens').innerHTML = m.itens.map((x, i) => `
      <div class="linha-peso" data-i="${i}">
        <textarea name="md-desc" rows="2" placeholder="Descrição do serviço" aria-label="Descrição do item ${i + 1}">${esc(x.descricao)}</textarea>
        <input name="md-peso" inputmode="decimal" value="${x.peso ? String(x.peso).replace('.', ',') : ''}" placeholder="%" aria-label="% do item ${i + 1}">
        ${m.itens.length > 1 ? `<button type="button" class="link-perigo" data-rem="${i}" aria-label="Remover item ${i + 1}">✕</button>` : '<span></span>'}
      </div>`).join('');
    // Campo da descrição cresce conforme o texto (para ler a descrição inteira no celular)
    $('#m-itens').querySelectorAll('textarea').forEach((t) => {
      const ajustar = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
      t.addEventListener('input', ajustar); ajustar();
    });
    $('#m-itens').querySelectorAll('[data-rem]').forEach((b) => {
      b.onclick = async () => { ler(); m.itens.splice(Number(b.dataset.rem), 1); await salvar(); desenhar(); };
    });
    mostrarSoma();
  };
  const ler = () => {
    m.itens = [...document.querySelectorAll('.linha-peso')].map((el) => ({
      descricao: el.querySelector('[name="md-desc"]').value, peso: lerValor(el.querySelector('[name="md-peso"]').value)
    }));
    const d = Object.fromEntries(new FormData($('#f-modelo')));
    m.nome = d.nome.trim(); m.escopo = d.escopo; m.observacoes = d.observacoes;
  };
  const mostrarSoma = () => {
    const s = somaPesos(m);
    $('#m-soma').innerHTML = s === 100
      ? 'Soma: <b class="positivo">100%</b> ✓'
      : `Soma: <b class="alerta">${s.toLocaleString('pt-BR')}%</b>. Não precisa fechar 100%: o app reparte na proporção. Mas fechando 100% fica mais fácil de conferir.`;
  };
  let timer;
  const salvar = async () => {
    clearTimeout(timer); _salvarPendente = null;
    ler(); m.atualizadoEm = agora();
    await gravar('modelos', m);
    $('#t-modelo').textContent = m.nome || 'Novo modelo';
    mostrarSoma();
    $('#salvo').textContent = 'Salvo no aparelho ✓ ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  const agendar = () => { clearTimeout(timer); _salvarPendente = salvar; timer = setTimeout(salvar, 700); };
  $('#f-modelo').addEventListener('input', agendar);
  $('#f-modelo').addEventListener('submit', (e) => e.preventDefault());
  $('#b-m-add').onclick = async () => {
    ler(); m.itens.push({ descricao: '', peso: 0 }); await salvar(); desenhar();
    const ds = document.querySelectorAll('[name="md-desc"]'); ds[ds.length - 1].focus();
  };
  $('#b-excluir-modelo').onclick = async () => {
    if (!confirm(`Excluir o modelo "${m.nome || 'sem nome'}"? Os orçamentos feitos com ele não mudam.`)) return;
    clearTimeout(timer); _salvarPendente = null;
    await excluir('modelos', m.id);
    aviso('Modelo excluído'); location.hash = '#/modelos';
  };
  desenhar();
}
