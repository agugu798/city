# City — servidor multiplayer

## Rodar
    node server.js          (precisa do Node 16+; não instala nada)
Abra http://localhost:3000 — quem abrir o link já entra no mesmo mundo.

## Pôr online (link pra todo mundo)
Suba a pasta num host Node (Render, Railway, Glitch...). Start command: `node server.js`.

## Variáveis (opcionais)
- ADM_SENHA   senha do ADM (padrão 2600 — troque!)
- ABERTO=1    qualquer nome entra, sem código
- APROVADOS   nomes que entram sem código, separados por vírgula
- DATA_DIR    onde salvar a lista de códigos (pessoas.json)

## Como funciona
- Jogadores aparecem uns pros outros em tempo real (posição, pulo, sentar, acenar).
- ADM: festa, luzes, fogos, confete, contagem e parar → disparam pra todos ao mesmo tempo.
- Códigos criados em "ADM · Adicionar pessoas" ficam salvos no servidor.
- Abrir public/index.html direto no navegador continua funcionando só offline (sem multiplayer).
