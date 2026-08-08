const WebSocket = require('ws');
const http = require('http');

// Porta do Servidor (definida automaticamente pelo Render ou 8080 localmente)
const PORT = process.env.PORT || 8080;

// Servidor HTTP básico
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor WebSocket para Gestão de Totens rodando perfeitamente!');
});

// Instância do WebSocket Server
const wss = new WebSocket.Server({ server });

// Armazenamento em memória dos Totens e do Painel Administrativo
const totems = {};
let adminSocket = null;

// Gerador de ID único para conexões de totens
function generateUniqueId() {
  return 'totem_' + Math.random().toString(36).substr(2, 9);
}

// Transmitir lista atualizada de totens para o Painel Administrativo
function notifyAdminTotemList() {
  if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
    const totemList = {};
    Object.keys(totems).forEach((id) => {
      totemList[id] = {
        id: id,
        storeName: totems[id].storeName,
        configured: totems[id].configured,
        online: totems[id].online,
        orientation: totems[id].orientation
      };
    });

    adminSocket.send(JSON.stringify({
      type: 'totem_list',
      totems: totemList
    }));
  }
}

/* =========================================================
   SISTEMA DE HEARTBEAT (Manter conexão viva em nuvem)
========================================================= */
function noop() {}

function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping(noop);
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

/* =========================================================
   GERENCIAMENTO DE CONEXÕES
========================================================= */
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  let clientType = null; // 'totem' ou 'admin'
  let clientId = null;

  console.log('Nova conexão estabelecida.');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {

        /* 1. REGISTRO DO PAINEL ADMINISTRATIVO */
        case 'register_admin':
          clientType = 'admin';
          adminSocket = ws;
          console.log('Painel Administrativo conectado.');
          notifyAdminTotemList();
          break;

        /* 2. REGISTRO DO TOTEM (TV / TV BOX) */
        case 'register_totem':
          clientType = 'totem';
          
          // Reutiliza o ID existente se o totem enviar, senão gera um novo
          clientId = data.totemId || generateUniqueId();
          
          const isConfigured = data.storeName && data.storeName !== 'Loja Não Configurada';

          totems[clientId] = {
            id: clientId,
            ws: ws,
            storeName: data.storeName || 'Novo Totem (Sem Nome)',
            configured: isConfigured,
            online: true,
            orientation: data.orientation || 'portrait'
          };

          console.log(`Totem registrado: ID [${clientId}] - Nome: "${totems[clientId].storeName}"`);

          // Responde ao totem confirmando seu ID
          ws.send(JSON.stringify({
            type: 'totem_registered',
            totemId: clientId
          }));

          notifyAdminTotemList();

          if (!isConfigured && adminSocket && adminSocket.readyState === WebSocket.OPEN) {
            adminSocket.send(JSON.stringify({
              type: 'new_totem_pending',
              totemId: clientId
            }));
          }
          break;

        /* 3. CONFIGURAÇÃO INICIAL DO TOTEM */
        case 'configure_totem':
          if (clientType === 'admin' && totems[data.totemId]) {
            const targetTotem = totems[data.totemId];
            targetTotem.storeName = data.storeName;
            targetTotem.configured = true;

            if (targetTotem.ws && targetTotem.ws.readyState === WebSocket.OPEN) {
              targetTotem.ws.send(JSON.stringify({
                command: 'set_store_name',
                name: data.storeName
              }));
            }

            console.log(`Totem ${data.totemId} configurado com o nome: ${data.storeName}`);
            notifyAdminTotemList();
          }
          break;

        /* 4. COMANDOS DO PAINEL ENVIADOS PARA O TOTEM */
        case 'totem_command':
          if (clientType === 'admin' && totems[data.totemId]) {
            const targetTotem = totems[data.totemId];

            if (targetTotem.ws && targetTotem.ws.readyState === WebSocket.OPEN) {
              
              if (data.command === 'set_store_name') {
                targetTotem.storeName = data.name;
                notifyAdminTotemList();
              }

              if (data.command === 'set_orientation') {
                targetTotem.orientation = data.orientation;
              }

              targetTotem.ws.send(JSON.stringify(data));
              console.log(`Comando "${data.command}" enviado para o totem: ${data.totemId}`);
            } else {
              console.warn(`Tentativa de envio para totem offline: ${data.totemId}`);
            }
          }
          break;

        default:
          console.warn('Tipo de mensagem não reconhecido:', data.type);
      }
    } catch (err) {
      console.error('Erro ao processar mensagem no servidor:', err);
    }
  });

  /* TRATAMENTO DE DESCONEXÃO */
  ws.on('close', () => {
    if (clientType === 'totem' && clientId && totems[clientId]) {
      console.log(`Totem desconectado: ${clientId}`);
      totems[clientId].online = false;
      notifyAdminTotemList();
    } else if (clientType === 'admin') {
      console.log('Painel Administrativo desconectado.');
      adminSocket = null;
    }
  });

  ws.on('error', (error) => {
    console.error('Erro de conexão WebSocket:', error);
  });
});

// Inicialização do Servidor
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Servidor Totem Mídia rodando na porta: ${PORT}`);
  console.log(` WebSocket pronto para receber conexões!`);
  console.log(`===================================================`);
});