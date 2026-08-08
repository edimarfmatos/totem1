const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

// Armazenamento em memória do estado dos totens (preserva nome e configurações)
const totems = {};
const admins = new Set();
const totemSockets = new Map(); // Mapeia totemId -> WebSocket

wss.on('connection', (ws) => {
  let clientType = null;
  let currentTotemId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // 1. Registro do Painel Administrativo
      if (data.type === 'register_admin') {
        clientType = 'admin';
        admins.add(ws);

        // Envia o estado consolidado com todos os totens cadastrados e seus status atuais
        ws.send(JSON.stringify({ type: 'init', totems }));
        return;
      }

      // 2. Registro / Reconexão do Totem
      if (data.type === 'register_totem' || data.totemId || data.id) {
        clientType = 'totem';
        currentTotemId = data.totemId || data.id;

        totemSockets.set(currentTotemId, ws);

        // Preserva dados anteriores (como nome customizado) e atualiza o status para 'online'
        totems[currentTotemId] = {
          ...(totems[currentTotemId] || {}),
          id: currentTotemId,
          ...data,
          status: 'online'
        };

        // Notifica todos os administradores conectados
        broadcastToAdmins({
          type: 'totem_connected',
          totemId: currentTotemId,
          status: 'online',
          totems: totems
        });
        return;
      }

      // 3. Comandos enviados do Painel Admin para o Totem
      if (data.type === 'totem_command' && data.totemId) {
        const id = data.totemId;

        // Atualiza e persiste as informações enviadas pelo admin (ex: nome, mídia, orientação)
        totems[id] = {
          ...(totems[id] || {}),
          ...data,
          status: totems[id]?.status || 'online'
        };

        // Repassa a instrução diretamente para a tela do totem, se estiver ativa
        const targetSocket = totemSockets.get(id);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
          targetSocket.send(JSON.stringify(data));
        }

        // Transmite o estado atualizado do totem para os painéis administrativos
        broadcastToAdmins({
          type: 'totem_updated',
          totemId: id,
          totems: totems
        });
      }
    } catch (error) {
      console.error('Erro ao processar mensagem recebida:', error);
    }
  });

  // Evento disparado quando uma conexão cai ou é fechada
  ws.on('close', () => {
    if (clientType === 'admin') {
      admins.delete(ws);
    } else if (clientType === 'totem' && currentTotemId) {
      totemSockets.delete(currentTotemId);

      // Altera o status para offline mantendo o nome e outras configurações salvas
      if (totems[currentTotemId]) {
        totems[currentTotemId].status = 'offline';
      }

      // Avisa os painéis administrativos sobre a queda de conexão do totem
      broadcastToAdmins({
        type: 'totem_disconnected',
        totemId: currentTotemId,
        status: 'offline',
        totems: totems
      });
    }
  });
});

// Função para transmitir mensagens para todos os painéis administrativos conectados
function broadcastToAdmins(payload) {
  const message = JSON.stringify(payload);
  admins.forEach((adminWs) => {
    if (adminWs.readyState === WebSocket.OPEN) {
      adminWs.send(message);
    }
  });
}

console.log(`Servidor WebSocket rodando na porta ${PORT}`);
