/**
 * [PT-BR] Servidor principal responsável por gerenciar sessões multiplayer via WebSocket
 * [EN] Main server responsible for handling multiplayer sessions through WebSocket
 */
const WebSocket = require('ws');
const crypto = require('crypto');

// [PT-BR] Dependência externa que fornece o transporte WebSocket do servidor
// [EN] External dependency that provides the server-side WebSocket transport
const wss = new WebSocket.Server({ host: "0.0.0.0", port: 9090 });

// [PT-BR] Mensagem de inicialização exibida quando o servidor entra em estado de escuta
// [EN] Startup message shown when the server enters listening mode
console.log("Servidor WebSocket rodando na porta 9090. Aguardando jogadores... | WebSocket server running on port 9090. Waiting for players...");

// [PT-BR] Registro em memória das salas ativas e de seus respectivos jogadores
// [EN] In-memory registry of active rooms and their associated players
let salas = {};

/*
============================================================
[PT-BR]
Fluxo central do servidor: cada nova conexão recebe um identificador único, passa a ser
associada opcionalmente a uma sala e troca mensagens estruturadas em JSON. Os comandos
aceitos neste ponto controlam criação de sala, entrada, início de partida e sincronização
de posição. A responsabilidade de autoridade permanece no servidor, que valida limites,
estado da sala e encaminha eventos para os demais clientes por broadcast.

[EN]
Core server flow: each new connection receives a unique identifier, may be associated with
a room, and exchanges structured JSON messages. The commands handled here control room
creation, joining, match start, and position synchronization. Authority remains on the
server, which validates room limits, room state, and forwards events to other clients via
broadcast.
============================================================
*/
wss.on('connection', (ws) => {
    // [PT-BR] Identificador único do cliente usado para rastrear sessão, autoridade e sincronização
    // [EN] Unique client identifier used to track session, authority, and synchronization
    ws.uuid = crypto.randomUUID();
    // [PT-BR] Referência da sala atual à qual o cliente pertence, quando aplicável
    // [EN] Current room reference for the client, when applicable
    ws.room = null;

    // [PT-BR] Confirma ao cliente que a conexão foi aceita e entrega o UUID de sessão
    // [EN] Confirms the connection was accepted and delivers the session UUID
    ws.send(JSON.stringify({ cmd: "joined_server", content: { uuid: ws.uuid } }));

    // [PT-BR] Recebe mensagens assíncronas do cliente, valida o pacote e roteia o comando
    // [EN] Receives asynchronous client messages, validates the packet, and routes the command
    ws.on('message', (message) => {
        // [PT-BR] O protocolo do servidor usa JSON textual como estrutura de pacote
        // [EN] The server protocol uses textual JSON as the packet structure
        const data = JSON.parse(message);
        // [PT-BR] Campo de comando que define a intenção da requisição do cliente
        // [EN] Command field that defines the client's request intent
        const cmd = data.cmd;
        // [PT-BR] Conteúdo transportado pelo pacote para ações e sincronização de estado
        // [EN] Payload carried by the packet for actions and state synchronization
        const content = data.content;

        // [PT-BR] Roteamento simples por comando para manter o servidor previsível e fácil de integrar ao plugin
        // [EN] Simple command routing to keep the server predictable and easy to integrate with the plugin
        switch (cmd) {
            case "create_room":
                // [PT-BR] Código curto de sala gerado no servidor para distribuição entre clientes
                // [EN] Short room code generated on the server for distribution between clients
                const codigo = Math.random().toString(36).substring(2, 7).toUpperCase();
                // [PT-BR] Limite de jogadores informado pelo cliente, com valor padrão conservador
                // [EN] Player limit provided by the client, with a conservative default value
                const limite = content.max_players || 10;

                // [PT-BR] Estrutura principal da sala: jogadores, host, limite e estado da partida
                // [EN] Core room structure: players, host, limit, and match state
                salas[codigo] = {
                    jogadores: {},
                    host: ws.uuid,
                    limite_jogadores: limite,
                    started: false
                };

                // [PT-BR] Vincula o criador à nova sala e registra sua presença em memória
                // [EN] Binds the creator to the new room and registers their presence in memory
                ws.room = codigo;
                salas[codigo].jogadores[ws.uuid] = ws;

                // [PT-BR] Log operacional para auditoria básica do fluxo de criação de sala
                // [EN] Operational log for basic auditing of the room creation flow
                console.log(`[+] Sala ${codigo} criada por ${ws.uuid}. (Máx: ${limite}) | Room ${codigo} created by ${ws.uuid}. (Max: ${limite})`);

                // [PT-BR] Resposta de confirmação da sala criada, incluindo a condição de host
                // [EN] Confirmation response for the created room, including host status
                ws.send(JSON.stringify({
                    cmd: "room_created",
                    content: { code: codigo, is_host: true }
                }));

                // [PT-BR] Spawna o jogador local no cliente criador com posição inicial padronizada
                // [EN] Spawns the local player on the creator client with a standardized initial position
                ws.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: { uuid: ws.uuid, x: 0, y: 5, z: 0 } }
                }));
                break;

            case "join_room":
                // [PT-BR] Normaliza o código da sala para manter o protocolo case-insensitive
                // [EN] Normalizes the room code to keep the protocol case-insensitive
                const salaCode = content.code.toUpperCase();

                // [PT-BR] Validação básica: rejeita tentativa de entrada em sala inexistente
                // [EN] Basic validation: rejects attempts to join a non-existent room
                if (!salas[salaCode]) {
                    ws.send(JSON.stringify({ cmd: "error", content: { msg: "Sala não encontrada!" } }));
                    return;
                }

                // [PT-BR] Referência local para a sala alvo, reduzindo repetição de acesso ao mapa global
                // [EN] Local reference to the target room, reducing repeated access to the global map
                const sala = salas[salaCode];

                // [PT-BR] Segurança de sessão: impede entrada tardia quando a partida já foi iniciada
                // [EN] Session safety: prevents late joining once the match has started
                if (sala.started) {
                    ws.send(JSON.stringify({ cmd: "error", content: { msg: "A partida já começou!" } }));
                    return;
                }

                // [PT-BR] Contagem atual de jogadores para aplicar o limite configurado pela sala
                // [EN] Current player count used to enforce the configured room limit
                const numJogadores = Object.keys(sala.jogadores).length;

                // [PT-BR] Controle de capacidade para evitar exceder a quantidade permitida de participantes
                // [EN] Capacity control to prevent exceeding the allowed number of participants
                if (numJogadores >= sala.limite_jogadores) {
                    ws.send(JSON.stringify({ cmd: "error", content: { msg: "A sala está cheia!" } }));
                    return;
                }

                // [PT-BR] Associa o cliente à sala e o adiciona ao conjunto de jogadores ativos
                // [EN] Associates the client with the room and adds it to the active player set
                ws.room = salaCode;
                sala.jogadores[ws.uuid] = ws;

                // [PT-BR] Log de entrada útil para rastreamento de sessão e depuração operacional
                // [EN] Join log useful for session tracing and operational debugging
                console.log(`[>] Jogador ${ws.uuid} entrou na sala ${salaCode} | Player ${ws.uuid} joined room ${salaCode}`);

                // [PT-BR] Confirma ao cliente que ele entrou na sala e que não é o host
                // [EN] Confirms to the client that they joined the room and are not the host
                ws.send(JSON.stringify({
                    cmd: "room_joined",
                    content: { code: salaCode, is_host: false }
                }));

                // [PT-BR] Broadcast para os demais clientes informando a chegada de um novo jogador
                // [EN] Broadcast to the other clients informing them of the new player arrival
                broadcast(salaCode, {
                    cmd: "spawn_new_player",
                    content: { player: { uuid: ws.uuid, x: 0, y: 5, z: 0 } }
                }, ws.uuid);

                // [PT-BR] Lista dos jogadores já presentes para replicação de estado ao recém-chegado
                // [EN] List of players already present for state replication to the newly joined client
                const listaVeteranos = [];
                for (const id in sala.jogadores) {
                    if (id !== ws.uuid) {
                        listaVeteranos.push({ uuid: id, x: 0, y: 5, z: 0 });
                    }
                }
                // [PT-BR] Envia os jogadores remotos que já existem na sala para sincronizar a cena local
                // [EN] Sends the remote players already in the room to synchronize the local scene
                ws.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: listaVeteranos }
                }));

                // [PT-BR] Envia o próprio avatar local do jogador recém-conectado
                // [EN] Sends the newly connected player's own local avatar
                ws.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: { uuid: ws.uuid, x: 0, y: 5, z: 0 } }
                }));
                break;

            case "start_game":
                // [PT-BR] Somente clientes vinculados a uma sala ativa podem solicitar o início da partida
                // [EN] Only clients bound to an active room can request match start
                if (ws.room && salas[ws.room]) {
                    // [PT-BR] Autoridade do host: apenas o criador da sala pode iniciar o jogo
                    // [EN] Host authority: only the room creator can start the game
                    if (salas[ws.room].host === ws.uuid) {
                        // [PT-BR] Marca a sala como iniciada para congelar o matchmaking dessa sessão
                        // [EN] Marks the room as started to freeze matchmaking for this session
                        salas[ws.room].started = true;
                        // [PT-BR] Log de auditoria para o disparo do estado inicial da partida
                        // [EN] Audit log for the dispatch of the initial match state
                        console.log(`[!] Partida iniciada pelo Host na sala ${ws.room} | Match started by the Host in room ${ws.room}`);

                        // [PT-BR] Broadcast de controle para que todos os clientes transitem para o estado de jogo
                        // [EN] Control broadcast so all clients transition into the gameplay state
                        broadcast(ws.room, { cmd: "start_game", content: {} });
                    }
                }
                break;

            case "position":
                // [PT-BR] Atualização de estado em tempo real enviada pelo cliente para replicação aos pares
                // [EN] Real-time state update sent by the client for replication to peers
                if (ws.room && salas[ws.room]) {
                    // [PT-BR] O servidor atua como autoridade de encaminhamento e distribui a posição atualizada
                    // [EN] The server acts as forwarding authority and distributes the updated position
                    broadcast(ws.room, {
                        cmd: "update_position",
                        content: {
                            uuid: ws.uuid,
                            x: content.x,
                            y: content.y,
                            z: content.z,
                            r_y: content.r_y
                        }
                    }, ws.uuid);
                }
                break;
        }
    });

    // [PT-BR] Limpeza de sessão quando a conexão é encerrada pelo cliente ou pela rede
    // [EN] Session cleanup when the connection is closed by the client or by the network
    ws.on('close', () => {
        if (ws.room && salas[ws.room]) {
            // [PT-BR] Log de desconexão para rastreamento do ciclo de vida do jogador
            // [EN] Disconnect log for tracking the player's lifecycle
            console.log(`[<] Jogador ${ws.uuid} desconectou da sala ${ws.room} | Player ${ws.uuid} disconnected from room ${ws.room}`);
            // [PT-BR] Remove o socket do conjunto de jogadores ativos da sala
            // [EN] Removes the socket from the room's active player set
            delete salas[ws.room].jogadores[ws.uuid];

            // [PT-BR] Notifica os demais participantes para que limpem o avatar remoto correspondente
            // [EN] Notifies the remaining participants to clean up the corresponding remote avatar
            broadcast(ws.room, {
                cmd: "player_disconnected",
                content: { uuid: ws.uuid }
            });

            // [PT-BR] Libera a sala da memória quando não houver mais jogadores conectados
            // [EN] Releases the room from memory when there are no more connected players
            if (Object.keys(salas[ws.room].jogadores).length === 0) {
                delete salas[ws.room];
                console.log(`[-] Sala ${ws.room} encerrada e removida da memória. | Room ${ws.room} closed and removed from memory.`);
            }
        }
    });
});

/**
 * [PT-BR] Envia uma mensagem serializada para todos os jogadores de uma sala, com opção de exclusão por UUID
 * [EN] Sends a serialized message to all players in a room, with optional exclusion by UUID
 *
 * @param {string} roomCode
 * @param {Object} messageObj
 * @param {string|null} excludeUuid
 */
function broadcast(roomCode, messageObj, excludeUuid = null) {
    // [PT-BR] Proteção contra chamadas para salas inexistentes ou já removidas
    // [EN] Guard against calls to non-existent or already removed rooms
    if (!salas[roomCode]) return;
    // [PT-BR] Serialização única da mensagem para reduzir custo de processamento no loop de envio
    // [EN] Single serialization of the message to reduce processing cost inside the send loop
    const msgString = JSON.stringify(messageObj);
    // [PT-BR] Cache local da lista de sockets da sala para iterar com baixo overhead
    // [EN] Local cache of the room socket list for low-overhead iteration
    const jogadores = salas[roomCode].jogadores;
    for (const id in jogadores) {
        // [PT-BR] Evita ecoar o evento de volta ao remetente quando o protocolo exige exclusão
        // [EN] Avoids echoing the event back to the sender when the protocol requires exclusion
        if (id !== excludeUuid) {
            jogadores[id].send(msgString);
        }
    }
}