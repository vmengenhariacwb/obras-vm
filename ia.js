'use strict';
// IA no app: o Vinicius descreve o serviço do jeito dele e a IA (Claude, da Anthropic) devolve o orçamento completo
// (título, escopo, itens com valores, prazo, observações e avisos só para ele).
//
// Segurança e custo:
// - A chave da API fica SÓ neste aparelho (localStorage). Nunca no código, no Drive nem no backup.
// - A tabela de preços fica na loja "ajustes" (privada: aparelho + pasta escondida do Drive).
// - Pagamento pré-pago no painel da Anthropic; acabou o crédito ou apagou a chave, a IA para e o resto do app segue igual.

const IA_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
const IA_MODELOS = {
  sonnet: { id: 'claude-sonnet-5-5', nome: 'Sonnet 5.5 (recomendado)', preco: { ent: 2, sai: 10, lido: 0.10, grav: 2.5 } },
  haiku: { id: 'claude-haiku-5-5', nome: 'Haiku 5.5 (econômico)', preco: { ent: 0.10, sai: 0.50, lido: 0.01, grav: 0.125 } }
};
const DOLAR = 5.5;   // só para mostrar o gasto aproximado em reais

// ----- chave e modelo: só neste aparelho
const lerLocal = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const gravarLocal = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } };
const chaveIA = () => lerLocal('ia-chave');
const modeloIA = () => IA_MODELOS[lerLocal('ia-modelo')] ? lerLocal('ia-modelo') : 'sonnet';

// ----- gasto do mês neste aparelho (estimado pelos tokens que a API informa)
function gastoMes() {
  try {
    const g = JSON.parse(lerLocal('ia-gasto') || '{}');
    return g.mes === hoje().slice(0, 7) ? g : { mes: hoje().slice(0, 7), usd: 0, n: 0 };
  } catch (e) { return { mes: hoje().slice(0, 7), usd: 0, n: 0 }; }
}
function custoUso(uso, chaveModelo) {
  const p = IA_MODELOS[chaveModelo].preco, M = 1e6;
  return ((uso.input_tokens || 0) * p.ent + (uso.output_tokens || 0) * p.sai
    + (uso.cache_read_input_tokens || 0) * p.lido + (uso.cache_creation_input_tokens || 0) * p.grav) / M;
}
function somarGasto(usd) {
  const g = gastoMes(); g.usd += usd; g.n += 1;
  gravarLocal('ia-gasto', JSON.stringify(g));
}
const dolar = (n) => 'US$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: n < 0.1 ? 3 : 2 });
const textoGasto = (usd) => `${dolar(usd)} (≈ ${moeda(usd * DOLAR)})`;

async function tabelaPrecos() { return (await pegar('ajustes', 'tabela-precos')) || null; }

// ----- instruções fixas (iguais em todo pedido: a API guarda e cobra bem menos a partir do 2º pedido)
const INSTRUCOES_IA = `Você monta orçamentos para a V&M Engenharia (engenharia civil, Curitiba/PR), do Eng. Vinicius Melin (CREA PR-184877/D).
O Vinicius descreve o serviço do jeito dele (muitas vezes ditando no celular, com erros de digitação) e você devolve o orçamento completo, pronto para ele revisar e enviar ao cliente.

Como montar:
- Itens: serviços de execução descritos de forma clara e profissional, na ordem em que acontecem na obra. Em geral de 4 a 10 itens; agrupe o que é pequeno.
- Em execução de obra, inclua quando fizer sentido: "Mobilização e desmobilização", "Transporte do entulho até a caçamba" (se houver demolição ou retirada) e "Engenharia, acompanhamento técnico e ART" (8% a 15% da mão de obra). Em serviço só técnico (projeto, regularização, laudo, ART), não use itens de obra.
- Unidades: use m², m ou un quando o Vinicius informar a medida; sem medida, use "vb" com quantidade 1. Nunca invente medidas.
- Valores: siga a tabela de preços de referência abaixo (valores ao cliente, de mão de obra, salvo quando a tabela diz "com material"). Use o "Típico". Só use o topo da faixa em área realmente pequena (abaixo de ~30 m²); de 30 a 100 m² fique no "Típico" e, acima de 100 m², pode ficar entre o mínimo e o "Típico". Use valores redondos, sem centavos.
- Siga a divisão da tabela: quando um serviço da tabela já inclui retirar e refazer (ex.: "Troca de ripas / ripamento"), use um item só, com o preço da tabela; não divida em "retirada" e "instalação" e não some os dois preços.
- Valor global: se ele disser um valor total (ex.: "18 mil", "valor global 18.000", "fechado em 7.500"), coloque em valor_global e distribua de forma coerente entre os itens (o app acerta a soma exata). Se ele não disser, valor_global = 0 e você precifica pela tabela.
- Fornecimento: "mo" quando ele disser que o material é por conta do cliente ou "só mão de obra"; "global" quando for material e mão de obra juntos (aí o valor unitário já inclui o material: estime com bom senso e avise em "avisos"). Se ele não disser, mantenha o fornecimento atual.
- Materiais (só no fornecimento "mo"): monte a lista do que o cliente vai comprar, como nas propostas da V&M (ex.: ripas de madeira tratada, caibros/terças para troca pontual, telhas de reposição do mesmo modelo, argamassa, pregos e fixadores, caçamba para entulho). Em cada material, a quantidade aproximada em texto ("aprox. 150 m", "aprox. 10% da área", "1 vb", "1 un") e o valor estimado a preço de loja de Curitiba (redondo). Calcule as quantidades pelo consumo usual e não superestime (ex.: ripas ≈ 3 m por m² de telhado; telhas de reposição ≈ 10% da área; troca "pontual" de madeiramento = poucas peças). Depois, uma faixa para o total de material (material_faixa_min e material_faixa_max), redonda, com o máximo cerca de 40% a 70% acima do mínimo, cobrindo a variação de preço entre lojas. No "global", materiais = [] e a faixa = 0.
- Escopo: um parágrafo de 2 a 5 frases descrevendo o que será feito, com base na vistoria. Profissional e sem valores.
- Prazo: estimativa realista em dias úteis; em serviço externo, diga que pode estender em caso de chuva.
- Observações: o que não está incluso, em 1 a 3 frases curtas (ex.: "Não incluso: pintura e forro.").
- avisos: notas só para o Vinicius, que não vão ao cliente: suposições que você fez, itens fora da faixa da tabela, o que confirmar na obra. Curto. Lista vazia se estiver tudo certo.
- Se já existe um orçamento atual e o pedido é um ajuste ("tira", "acrescenta", "aumenta", "muda"), parta do orçamento atual e mude só o que foi pedido.

Regras de texto (obrigatórias):
- Nunca use "arquiteto", "arquitetos", "engenharia e arquitetura", "RRT", "CAU" nem "BALDRA". A V&M é engenharia civil e emite ART.
- Nunca deixe texto por preencher, como "[...]" ou "a definir".
- Não escreva garantia nem forma de pagamento: o app coloca o padrão da V&M.
- Português do Brasil, linguagem profissional e simples.`;

const ESQUEMA_IA = {
  type: 'object',
  properties: {
    servico: { type: 'string', description: 'Título curto do serviço' },
    escopo: { type: 'string' },
    fornecimento: { type: 'string', enum: ['global', 'mo'] },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descricao: { type: 'string' },
          un: { type: 'string' },
          qtd: { type: 'number' },
          valor_unit: { type: 'number', description: 'Valor por unidade que vai ao cliente (mão de obra no "mo"; material + mão de obra no "global")' }
        },
        required: ['descricao', 'un', 'qtd', 'valor_unit'],
        additionalProperties: false
      }
    },
    materiais: {
      type: 'array',
      description: 'Só no "mo": materiais que o cliente compra. No "global", lista vazia.',
      items: {
        type: 'object',
        properties: {
          descricao: { type: 'string' },
          quantidade: { type: 'string', description: 'Quantidade aproximada em texto, ex.: "aprox. 150 m"' },
          valor_estimado: { type: 'number' }
        },
        required: ['descricao', 'quantidade', 'valor_estimado'],
        additionalProperties: false
      }
    },
    material_faixa_min: { type: 'number' },
    material_faixa_max: { type: 'number' },
    valor_global: { type: 'number', description: 'Valor total que o Vinicius pediu; 0 se ele não disse' },
    prazo: { type: 'string' },
    observacoes: { type: 'string' },
    avisos: { type: 'array', items: { type: 'string' } }
  },
  required: ['servico', 'escopo', 'fornecimento', 'itens', 'materiais', 'material_faixa_min', 'material_faixa_max', 'valor_global', 'prazo', 'observacoes', 'avisos'],
  additionalProperties: false
};

let _cliente = null, _chaveCliente = '';
async function clienteIA() {
  const chave = chaveIA();
  if (!chave) throw new Error('falta a chave da IA neste aparelho (Orçamentos › IA do app)');
  if (_cliente && _chaveCliente === chave) return _cliente;
  let mod;
  try { mod = await import(IA_SDK); } catch (e) { throw new Error('sem internet para falar com a IA. Tente de novo com sinal.'); }
  const Anthropic = mod.default || mod.Anthropic;
  // A chave é sua e só fica neste aparelho: por isso o app fala direto com a Anthropic, sem servidor no meio.
  _cliente = new Anthropic({ apiKey: chave, dangerouslyAllowBrowser: true, maxRetries: 2 });
  _chaveCliente = chave;
  return _cliente;
}

// Traduz os erros da API para português
function erroIA(e) {
  const s = e && e.status, msg = String((e && e.message) || e || '');
  if (s === 401) return new Error('a chave da IA não foi aceita. Confira se colou a chave inteira ou se ela foi apagada no painel.');
  if (s === 403) return new Error('a chave não tem permissão para usar a IA. Confira no painel da Anthropic.');
  if (/credit balance|billing|crédito/i.test(msg)) return new Error('acabou o crédito no painel da Anthropic. Coloque mais crédito para voltar a usar a IA.');
  if (s === 429) return new Error('muitos pedidos ou limite de gasto do mês atingido. Espere um pouco ou confira o limite no painel.');
  if (s === 529 || s >= 500) return new Error('a IA está sobrecarregada agora. Tente de novo em alguns minutos.');
  if (/fetch|network|Failed/i.test(msg)) return new Error('sem internet para falar com a IA. Tente de novo com sinal.');
  return new Error('a IA respondeu com erro: ' + msg.slice(0, 160));
}

// Orçamentos anteriores como exemplo de estilo e preço: só os que você ENVIOU ou foram APROVADOS (rascunhos e
// testes ficam de fora, senão a IA copia o próprio rascunho). Sem nome de cliente nem endereço.
async function exemplosIA(idAtual) {
  const os = (await todos('orcamentos')).filter((o) => o.id !== idAtual && ['Aprovado', 'Enviado'].includes(o.situacao)
    && (o.itens || []).some((it) => (it.descricao || '').trim()));
  const ordem = (o) => (o.situacao === 'Aprovado' ? 0 : o.situacao === 'Enviado' ? 1 : 2);
  return os.sort((a, b) => ordem(a) - ordem(b) || (b.atualizadoEm || '').localeCompare(a.atualizadoEm || '')).slice(0, 3)
    .map((o) => ({
      servico: o.servico, situacao: o.situacao, fornecimento: o.fornecimento === 'mo' ? 'mo' : 'global',
      itens: o.itens.filter((it) => (it.descricao || '').trim()).map((it) => ({
        descricao: it.descricao, un: it.un, qtd: it.qtd, valor_unit: o.fornecimento === 'mo' ? it.valorMo : it.valor
      })),
      total: totaisOrc(o).contrato
    }));
}

// Pede o orçamento à IA. Devolve { r: resposta, usd: custo, modelo }.
async function montarComIA(o, pedido) {
  const tabela = await tabelaPrecos();
  const cliente = await clienteIA();
  const chaveModelo = modeloIA();
  const atual = {
    servico: o.servico, necessidade_vistoria: o.necessidade, medidas_e_anotacoes: o.medidas, local: o.local,
    fornecimento_atual: o.fornecimento === 'mo' ? 'mo' : 'global',
    itens: (o.itens || []).filter((it) => (it.descricao || '').trim()).map((it) => ({
      descricao: it.descricao, un: it.un, qtd: it.qtd, valor_unit: o.fornecimento === 'mo' ? it.valorMo : it.valor
    })),
    materiais: o.fornecimento === 'mo' ? (o.materiais || []).filter((m) => (m.descricao || '').trim())
      .map((m) => ({ descricao: m.descricao, quantidade: m.qtd, valor_estimado: m.valor || 0 })) : [],
    material_faixa: o.fornecimento === 'mo' ? [o.materialMin || 0, o.materialMax || 0] : [],
    prazo: o.prazo, observacoes: o.observacoes
  };
  const conteudo = [
    `Orçamento atual (pode estar vazio):\n${JSON.stringify(atual, null, 1)}`,
    `Orçamentos anteriores do Vinicius (siga o estilo e os preços):\n${JSON.stringify(await exemplosIA(o.id), null, 1)}`,
    `Pedido do Vinicius:\n${pedido}`
  ].join('\n\n');
  let resp;
  try {
    resp = await cliente.messages.create({
      model: IA_MODELOS[chaveModelo].id,
      max_tokens: 16000,
      system: [
        { type: 'text', text: INSTRUCOES_IA },
        {
          type: 'text',
          text: tabela && tabela.texto ? `Tabela de preços de referência da V&M:\n\n${tabela.texto}` : 'Tabela de preços: ainda não importada no app. Estime com preços de mercado de Curitiba e avise isso em "avisos".',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: conteudo }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA_IA } }
    });
  } catch (e) { console.error(e); throw erroIA(e); }
  const usd = custoUso(resp.usage || {}, chaveModelo);
  somarGasto(usd);
  if (resp.stop_reason === 'refusal') throw new Error('a IA não quis montar esse orçamento. Reescreva o pedido com outras palavras.');
  if (resp.stop_reason === 'max_tokens') throw new Error('a resposta da IA ficou grande demais. Peça um orçamento mais resumido.');
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let r;
  try { r = JSON.parse(txt); } catch (e) { throw new Error('a resposta da IA veio num formato inesperado. Tente de novo.'); }
  if (!Array.isArray(r.itens) || !r.itens.length) throw new Error('a IA não devolveu itens. Descreva um pouco mais o serviço.');
  return { r, usd, modelo: chaveModelo };
}

// ---------------------------------------------------------------- tela "IA do app"
async function telaIA(main) {
  const tab = await tabelaPrecos();
  const g = gastoMes();
  const chave = chaveIA();
  main.innerHTML = `
    <a class="voltar" href="#/orcamentos">‹ Orçamentos</a>
    <h1>IA do app</h1>
    <p class="sub">A IA monta o orçamento a partir do que você descrever. Ela usa a sua tabela de preços e os seus últimos orçamentos como exemplo.</p>

    <div class="card">
      <h2 style="margin-top:0">1. Chave da IA (só neste aparelho)</h2>
      <p class="sub" style="margin:0">${chave ? `Chave guardada: <b>…${esc(chave.slice(-4))}</b>` : 'Nenhuma chave neste aparelho.'}</p>
      <label for="ia-chave">${chave ? 'Trocar a chave' : 'Cole aqui a chave criada no painel da Anthropic'}</label>
      <input id="ia-chave" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-...">
      <div class="botoes lado">
        <button class="btn" id="b-ia-salvar" type="button">Guardar chave</button>
        ${chave ? '<button class="btn perigo" id="b-ia-apagar" type="button">Apagar chave deste aparelho</button>' : ''}
      </div>
      <p class="sub" style="margin:.6rem 0 0">A chave fica só neste aparelho: não vai para o Drive, para o backup nem para o código do app. No celular e no PC, cole a chave uma vez em cada um.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">2. Modelo</h2>
      <div class="segmento" role="radiogroup" aria-label="Modelo da IA">
        ${Object.entries(IA_MODELOS).map(([k, m]) => `<label><input type="radio" name="ia-modelo" value="${k}" ${modeloIA() === k ? 'checked' : ''}><span>${esc(m.nome)}</span></label>`).join('')}
      </div>
      <p class="sub" style="margin:.6rem 0 0">Sonnet: cerca de R$ 0,15 a 0,30 por orçamento, monta melhor. Haiku: centavos, bom para coisas simples.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">3. Tabela de preços</h2>
      <p class="sub" style="margin:0">${tab && tab.texto ? `Importada${tab.nomeArquivo ? ` de <b>${esc(tab.nomeArquivo)}</b>` : ''} em ${esc(new Date(tab.atualizadoEm).toLocaleString('pt-BR'))} (${tab.texto.length.toLocaleString('pt-BR')} caracteres). Sincroniza pelo Drive.` : 'Ainda não importada: sem ela, a IA estima pelo mercado.'}</p>
      <label class="add-foto" style="min-height:64px;margin-top:.8rem">Importar tabela (.md ou .txt)<input id="ia-tabela" type="file" accept=".md,.txt,text/plain,text/markdown"></label>
      ${tab && tab.texto ? '<details style="margin-top:.6rem"><summary>Ver a tabela</summary><pre class="tabela-ia"></pre></details>' : ''}
    </div>

    <div class="card">
      <h2 style="margin-top:0">4. Gasto e teste</h2>
      <p style="margin:0">Este mês, neste aparelho: <b>${textoGasto(g.usd)}</b> em ${g.n} pedido(s).</p>
      <p class="sub" style="margin:.3rem 0 0">Estimativa pelo que a Anthropic informa em cada pedido. O valor oficial e o limite mensal ficam no painel da Anthropic.</p>
      <div class="botoes"><button class="btn sec" id="b-ia-testar" type="button">Testar a conexão (custa menos de 1 centavo)</button></div>
    </div>`;

  if ($('.tabela-ia')) $('.tabela-ia').textContent = tab.texto;
  $('#b-ia-salvar').onclick = () => {
    const v = $('#ia-chave').value.trim();
    if (!/^sk-ant-/.test(v)) { aviso('A chave começa com "sk-ant-". Copie de novo no painel.', 4000); return; }
    gravarLocal('ia-chave', v); _cliente = null;
    aviso('Chave guardada neste aparelho'); telaIA(main);
  };
  if ($('#b-ia-apagar')) $('#b-ia-apagar').onclick = () => {
    if (!confirm('Apagar a chave deste aparelho? A IA para de funcionar aqui até você colar a chave de novo.')) return;
    gravarLocal('ia-chave', ''); _cliente = null;
    aviso('Chave apagada deste aparelho'); telaIA(main);
  };
  document.querySelectorAll('input[name="ia-modelo"]').forEach((r) => { r.onchange = () => { gravarLocal('ia-modelo', r.value); aviso('Modelo: ' + IA_MODELOS[r.value].nome); }; });
  $('#ia-tabela').onchange = async (e) => {
    const arq = e.target.files[0]; if (!arq) return;
    const texto = (await arq.text()).trim();
    if (texto.length < 50) { aviso('Esse arquivo parece vazio', 3500); return; }
    if (texto.length > 60000) { aviso('Arquivo grande demais para a tabela (máx. 60 mil caracteres)', 4000); return; }
    await gravar('ajustes', { id: 'tabela-precos', texto, nomeArquivo: arq.name, atualizadoEm: agora() });
    aviso('Tabela de preços importada'); telaIA(main);
  };
  $('#b-ia-testar').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Testando...';
    try {
      const cliente = await clienteIA();
      const resp = await cliente.messages.create({ model: IA_MODELOS[modeloIA()].id, max_tokens: 64, messages: [{ role: 'user', content: 'Responda só: OK' }] });
      const usd = custoUso(resp.usage || {}, modeloIA()); somarGasto(usd);
      aviso('Conexão funcionando ✓', 3500); telaIA(main);
    } catch (err) { console.error(err); aviso('Erro: ' + (err.status ? erroIA(err) : err).message, 6000); b.disabled = false; b.textContent = 'Testar a conexão'; }
  };
}

// ---------------------------------------------------------------- leitura de nota fiscal (foto → lançamento)
// A foto vai só para a IA ler; o app guarda a foto como comprovante do lançamento (aparelho + Drive).
const esquemaNF = () => ({
  type: 'object',
  properties: {
    eh_nota: { type: 'boolean', description: 'true se a imagem é uma nota fiscal, cupom, recibo ou boleto de compra/serviço' },
    fornecedor: { type: 'string', description: 'Nome da loja ou prestador (nome fantasia se houver, curto)' },
    cnpj_fornecedor: { type: 'string', description: 'CNPJ ou CPF do emitente, como aparece; vazio se não aparecer' },
    numero_nota: { type: 'string', description: 'Número da nota/cupom; vazio se não aparecer' },
    data_emissao: { type: 'string', description: 'AAAA-MM-DD; vazio se não der para ler' },
    vencimento: { type: 'string', description: 'AAAA-MM-DD do vencimento se a nota mostrar boleto/duplicata a pagar; senão vazio' },
    valor_total: { type: 'number', description: 'Valor total a pagar da nota, em reais (0 se não der para ler)' },
    forma_pagamento: { type: 'string', enum: FORMAS, description: 'Como foi pago, se a nota mostrar; vazio se não mostrar' },
    descricao_curta: { type: 'string', description: 'Resumo do que foi comprado em até 6 palavras, ex.: "Cimento, areia e argamassa"' },
    classificacao: { type: 'string', enum: CLASSIFICACOES },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: { descricao: { type: 'string' }, quantidade: { type: 'string' }, valor: { type: 'number' } },
        required: ['descricao', 'quantidade', 'valor'],
        additionalProperties: false
      }
    },
    avisos: { type: 'array', items: { type: 'string' }, description: 'O que ficou ilegível ou duvidoso; lista vazia se tudo certo' }
  },
  required: ['eh_nota', 'fornecedor', 'cnpj_fornecedor', 'numero_nota', 'data_emissao', 'vencimento', 'valor_total', 'forma_pagamento', 'descricao_curta', 'classificacao', 'itens', 'avisos'],
  additionalProperties: false
});

const INSTRUCOES_NF = `Você lê fotos de notas fiscais, cupons e recibos de despesas de obra da V&M Engenharia (Curitiba/PR) e devolve os dados para o lançamento financeiro.
- Leia exatamente o que está escrito. Nunca invente: o que não der para ler fica vazio (ou 0) e entra em "avisos".
- valor_total: o total final a pagar (depois de descontos), não a soma de impostos.
- Datas no formato AAAA-MM-DD. Notas brasileiras usam DD/MM/AAAA.
- classificacao: "Material" para material de construção; "Equipamentos/locação" para aluguel de equipamento, caçamba ou andaime; "Mão de obra" ou "Prestação de serviços" para serviço; "Contas" para água, luz, internet; "Impostos" para guias e tributos; "Fornecedor" se não se encaixar.
- itens: os produtos da nota, com quantidade e unidade em texto (ex.: "10 sc", "2 m³") e valor total do item. No máximo 30 itens; se houver mais, agrupe os últimos.
- Se a imagem não for nota/cupom/recibo, eh_nota = false.`;

async function blobParaBase64(blob) {
  const url = await new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = erro; r.readAsDataURL(blob); });
  return String(url).split(',')[1];
}

// Lê a nota fiscal da foto. Devolve { r, usd }.
async function lerNotaFiscal(blob) {
  const cliente = await clienteIA();
  const chaveModelo = modeloIA();
  let resp;
  try {
    resp = await cliente.messages.create({
      model: IA_MODELOS[chaveModelo].id,
      max_tokens: 8000,
      system: INSTRUCOES_NF,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobParaBase64(blob) } },
          { type: 'text', text: `Leia esta nota. Hoje é ${hoje()}.` }
        ]
      }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: esquemaNF() } }
    });
  } catch (e) { console.error(e); throw erroIA(e); }
  const usd = custoUso(resp.usage || {}, chaveModelo);
  somarGasto(usd);
  if (resp.stop_reason === 'refusal') throw new Error('a IA não conseguiu ler essa imagem.');
  if (resp.stop_reason === 'max_tokens') throw new Error('a nota tem itens demais para ler de uma vez.');
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let r;
  try { r = JSON.parse(txt); } catch (e) { throw new Error('a resposta da IA veio num formato inesperado. Tente de novo.'); }
  return { r, usd };
}
