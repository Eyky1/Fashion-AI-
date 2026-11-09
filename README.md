# Fábia Multimarcas

Loja online responsiva com catálogo e carrinho no navegador, checkout por WhatsApp e painel administrativo para produtos, estoque e pedidos. Produtos e pedidos ficam em SQLite; imagens de catálogo são armazenadas localmente em `static/uploads/`.

## Requisitos

- Python 3.10 ou mais recente
- pip

## Executar localmente no Windows

No PowerShell, a partir desta pasta:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:FLASK_SECRET_KEY = (py -c "import secrets; print(secrets.token_hex(32))")
$env:WHATSAPP_NUMBER = "5511999999999" # substitua pelo número real da loja
$env:ADMIN_ENABLED = "1" # habilita o painel somente para desenvolvimento local
py app.py
```

Abra `http://127.0.0.1:5000/admin/login`. No primeiro acesso local, crie e confirme uma senha com pelo menos 12 caracteres; depois, entre com a senha recém-criada. O hash da senha fica no SQLite, nunca a senha em texto puro. Tentativas incorretas de login são temporariamente bloqueadas após cinco falhas.

A vitrine também está disponível na raiz. Configure o número do WhatsApp com código do país e DDD, somente dígitos (por exemplo, `5511999999999`). O painel fica desabilitado por padrão (`ADMIN_ENABLED=0`); nessa configuração, páginas administrativas, APIs de gestão e operações de escrita de produtos respondem como não encontradas, mesmo que a sessão tenha autenticação. Para desenvolvimento local, ative-o explicitamente com `ADMIN_ENABLED=1` e mantenha o servidor ligado apenas a `127.0.0.1`. **Na implantação pública da loja, deixe `ADMIN_ENABLED=0` ou remova a variável.** Para publicação com HTTPS, defina `COOKIE_SECURE=1`, configure uma `FLASK_SECRET_KEY` estável e forte e use um servidor WSGI apropriado, como Waitress ou Gunicorn. Se a configuração antiga `ADMIN_PASSWORD` já estiver definida, a primeira inicialização migra o valor para um hash no banco; a senha passa a ser gerenciada por esse banco.

## Estrutura

```text
.
├── app.py                 # Flask, API, autenticação e persistência SQLite
├── instance/              # Banco criado automaticamente na primeira execução
├── static/
│   ├── css/styles.css     # Identidade visual responsiva
│   ├── js/                # Interações da loja e do painel
│   ├── uploads/           # Imagens de produtos enviadas pela lojista
│   ├── media/             # Fotos da loja
│   └── videos/            # Vídeo de apresentação da marca
├── templates/             # Vitrine, login e painel administrativo
├── .env.example           # Variáveis necessárias (referência)
└── requirements.txt
```

## Fluxos

- Cadastre e atualize produtos, fotos e quantidades por tamanho no painel. Cada peça tem uma referência interna obrigatória e única, pesquisável na lista administrativa; produtos antigos recebem automaticamente uma referência `AUTO-...` durante a migração.
- Cadastre de 5 a 40 peças por vez, com uma foto e grade de estoque para cada produto. A leitura opcional da etiqueta em português é feita no navegador; confira nome, referência, preço e estoque reconhecidos antes de salvar. A primeira leitura baixa o mecanismo e os dados de idioma da internet.
- O carrinho é salvo no `localStorage`; no checkout, a cliente informa nome e WhatsApp para identificar o pedido e conversar sobre pagamento e entrega. Não é necessário criar conta. Esses dados ficam disponíveis somente no painel administrativo.
- Ao enviar um pedido, as unidades são reservadas imediatamente em uma transação SQLite, evitando vender além do estoque. A lojista confirma a venda no painel; ao cancelar um pedido pendente, as unidades reservadas voltam ao estoque. Produtos esgotados continuam no catálogo administrativo e aparecem como “ESGOTADO” na vitrine; podem ser removidos pelo painel quando desejado.
- O painel permite buscar pedidos, consultar histórico agrupado por WhatsApp, ver vendas confirmadas por período, ajustar alertas de estoque baixo e baixar os pedidos em CSV, um arquivo de planilha que abre no Excel ou Google Planilhas.
- As imagens são aceitas quando o conteúdo corresponde a JPG, PNG ou WebP, com limite de 5 MB por imagem. Imagens substituídas ou sem produto associado são removidas.
- A sacola aceita até 50 combinações de produto e tamanho; os dados inválidos do `localStorage` são descartados sem interromper a vitrine.
- O montador de looks combina peças recortadas em PNG/WebP transparente sobre uma silhueta ilustrativa de manequim fantasma. A lojista pode enviar a imagem recortada opcional no cadastro do produto; peças sem recorte são indicadas na prévia. A montagem é ilustrativa e não representa o caimento real.
- Hotspots da seção “Conheça a loja” destacam os três primeiros produtos disponíveis. A foto de fundo pode ser substituída pela imagem da loja quando for fornecida.
- O vídeo `static/videos/fabia-hero.mp4` aparece no destaque inicial, com a mensagem da marca sobreposta; ele inicia sem som e oferece controles para pausar ou ativar o áudio.
- O endereço informado é exibido com um atalho para traçar a rota no Google Maps, e o perfil oficial está vinculado na seção de visita.
- A vitrine consulta a API sem cache e atualiza o catálogo automaticamente a cada 15 segundos, além de atualizar ao voltar à aba. Mantenha o painel e a loja abertos pelo mesmo servidor e endereço local.
