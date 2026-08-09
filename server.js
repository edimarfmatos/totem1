const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

// Estado global mantido na memória do servidor
const totems = {};
const admins = new Set();
const totemSockets = new Map();

wss.on('connection', (ws) => {
  let clientType = null;
  let currentTotemId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // 1. REGISTRO DO PAINEL ADMINISTRATIVO
      if (data.type === 'register_admin') {
        clientType = 'admin';
        admins.add(ws);
        
        // Envia o estado completo de todos os totems cadastrados
        ws.send(JSON.stringify({ type: 'init', totems }));
        return;
      }

      // 2. REGISTRO / RECONEXÃO DO TOTEM
      if (data.type === 'register_totem' || data.totemId || data.id) {
        clientType = 'totem';
        currentTotemId = data.totemId || data.id;

        totemSockets.set(currentTotemId, ws);

        // Mescla dados antigos (nome, imagens, vídeos, rodapé) com os novos dados de conexão
        totems[currentTotemId] = {
          ...(totems[currentTotemId] || {}),
          ...data,
          id: currentTotemId,
          status: 'online'
        };

        // ENVIAR DE VOLTA AO TOTEM: Devolve todas as configurações salvas (mídia/rodapé)
        // para que a tela do totem restaure tudo automaticamente ao ligar
        ws.send(JSON.stringify({
          type: 'restore_state',
          ...totems[currentTotemId]
        }));

        // Notifica o painel administrativo que o totem ficou online com seus dados atualizados
        broadcastToAdmins({
          type: 'totem_connected',
          totemId: currentTotemId,
          status: 'online',
          totems: totems
        });
        return;
      }

      // 3. COMANDOS E ATUALIZAÇÕES DO PAINEL ADMIN PARA OS TOTENS
      // Aceita comandos genéricos, envio de imagens, vídeos, rodapés e orientações
      if (currentTotemId || data.totemId) {
        const id = data.totemId || currentTotemId;

        // Atualiza a memória mantendo tudo o que já existia (nome, status, etc.)
        totems[id] = {
          ...(totems[id] || {}),
          ...data,
          status: totems[id]?.status || 'online'
        };

        // Repassa o comando exato recebido para a tela do totem alvo
        const targetSocket = totemSockets.get(id);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
          targetSocket.send(JSON.stringify(totems[id]));
        }

        // Atualiza os painéis administradores em tempo real
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

  // 4. TRATAMENTO DE DESCONEXÃO
  ws.on('close', () => {
    if (clientType === 'admin') {
      admins.delete(ws);
    } else if (clientType === 'totem' && currentTotemId) {
      totemSockets.delete(currentTotemId);

      // Marca como offline, mas PRESERVA nome, imagem, vídeo e rodapé
      if (totems[currentTotemId]) {
        totems[currentTotemId].status = 'offline';
      }

      // Notifica o painel admin sobre a queda de sinal
      broadcastToAdmins({
        type: 'totem_disconnected',
        totemId: currentTotemId,
        status: 'offline',
        totems: totems
      });
    }
  });
});

function broadcastToAdmins(payload) {
  const message = JSON.stringify(payload);
  admins.forEach((adminWs) => {
    if (adminWs.readyState === WebSocket.OPEN) {
      adminWs.send(message);
    }
  });
}

console.log(`Servidor WebSocket rodando na porta ${PORT}`);
