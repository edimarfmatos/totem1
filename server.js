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

// Armazenamento em memória do estado dos Totens e Administradores
const totems = {};
const adminSockets = new Set(); // Suporta múltiplos painéis de administração abertos

// Gerador de ID único para conexões de totens
function generateUniqueId() {
  return 'totem_' + Math.random().toString(36).substr(2, 9);
}

// Transmitir lista atualizada de totens para todos os Painéis Administrativos conectados
function notifyAdminTotemList() {
  const totemList = {};
  Object.keys(totems).forEach((id) => {
    totemList[id] = {
      id: id,
      storeName: totems[id].storeName,
      configured: totems[id].configured,
      online: totems[id].online,
      orientation: totems[id].orientation,
      lastCommands: totems[id].lastCommands || {} // Mantém histórico de mídias/rodapé
    };
  });

  const payload = JSON.stringify({
    type: 'totem_list',
    totems: totemList
  });

  adminSockets.forEach((adminWs) => {
    if (adminWs.readyState === WebSocket.OPEN) {
      adminWs.send(payload);
    }
  });
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
   GERENCIAMENTO DE CONEXÕES E MENSAGENS
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
          adminSockets.add(ws);
          console.log('Painel Administrativo conectado.');
          notifyAdminTotemList();
          break;

        /* 2. REGISTRO / RECONEXÃO DO TOTEM (TV / TV BOX) */
        case 'register_totem':
          clientType = 'totem';
          clientId = data.totemId || generateUniqueId();

          const existingTotem = totems[clientId] || {};
          const isConfigured = Boolean(
            data.storeName && data.storeName !== 'Loja Não Configurada'
          ) || (existingTotem.configured || false);

          // Preserva as mídias e configurações antigas se o totem caiu e voltou
          totems[clientId] = {
            ...existingTotem,
            id: clientId,
            ws: ws,
            storeName: data.storeName || existingTotem.storeName || 'Novo Totem (Sem Nome)',
            configured: isConfigured,
            online: true,
            orientation: data.orientation || existingTotem.orientation || 'portrait',
            lastCommands: existingTotem.lastCommands || {}
          };

          console.log(`Totem registrado: ID [${clientId}] - Nome: "${totems[clientId].storeName}"`);

          // Responde ao totem confirmando seu ID
          ws.send(JSON.stringify({
            type: 'totem_registered',
            totemId: clientId
          }));

          // REFORÇO: Restaura na tela do totem as mídias/rodapé/orientação salvas
          if (totems[clientId].lastCommands) {
            Object.values(totems[clientId].lastCommands).forEach((cmdData) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(cmdData));
              }
            });
          }

          notifyAdminTotemList();

          // Notifica painel se for um totem pendente de configuração
          if (!isConfigured) {
            adminSockets.forEach((adminWs) => {
              if (adminWs.readyState === WebSocket.OPEN) {
                adminWs.send(JSON.stringify({
                  type: 'new_totem_pending',
                  totemId: clientId
                }));
              }
            });
          }
          break;

        /* 3. CONFIGURAÇÃO INICIAL DO TOTEM (NOME DA LOJA) */
        case 'configure_totem':
          if (clientType === 'admin' && totems[data.totemId]) {
            const targetTotem = totems[data.totemId];
            targetTotem.storeName = data.storeName;
            targetTotem.configured = true;

            const nameCmd = {
              command: 'set_store_name',
              name: data.storeName
            };

            targetTotem.lastCommands['set_store_name'] = nameCmd;

            if (targetTotem.ws && targetTotem.ws.readyState === WebSocket.OPEN) {
              targetTotem.ws.send(JSON.stringify(nameCmd));
            }

            console.log(`Totem ${data.totemId} configurado com o nome: ${data.storeName}`);
            notifyAdminTotemList();
          }
          break;

        /* 4. COMANDOS DO PAINEL ENVIADOS PARA O TOTEM (IMAGEM, VÍDEO, RODAPÉ, ORIENTAÇÃO) */
        case 'totem_command':
          if (clientType === 'admin' && totems[data.totemId]) {
            const targetTotem = totems[data.totemId];

            // Atualiza estados específicos no objeto do totem
            if (data.command === 'set_store_name') {
              targetTotem.storeName = data.name || data.storeName;
            }
            if (data.command === 'set_orientation' || data.orientation) {
              targetTotem.orientation = data.orientation || targetTotem.orientation;
            }

            // Salva o último comando enviado do tipo (ex: imagem, vídeo, rodapé) para reidratar se o totem reiniciar
            const commandKey = data.command || data.action || 'generic_command';
            targetTotem.lastCommands[commandKey] = data;

            // Envia o comando em tempo real para a tela do totem se estiver online
            if (targetTotem.ws && targetTotem.ws.readyState === WebSocket.OPEN) {
              targetTotem.ws.send(JSON.stringify(data));
              console.log(`Comando "${commandKey}" enviado com sucesso para o totem: ${data.totemId}`);
            } else {
              console.warn(`Comando "${commandKey}" salvo. Totem offline no momento: ${data.totemId}`);
            }

            notifyAdminTotemList();
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
      totems[clientId].ws = null; // Libera a referência do socket
      notifyAdminTotemList();
    } else if (clientType === 'admin') {
      console.log('Painel Administrativo desconectado.');
      adminSockets.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('Erro de conexão WebSocket:', error);
  });
});

// Inicialização do Servidor HTTP / WebSocket
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Servidor Totem Mídia rodando na porta: ${PORT}`);
  console.log(` WebSocket pronto para receber conexões!`);
  console.log(`===================================================`);
});
