import http from 'http';
import { Server } from 'socket.io';

import { config } from '../config/config';
import Logging from '../library/Logging';
import { VerifySocketToken } from '../middleware/SocketAuth';
import Message from '../models/Message';
import type { ChatJoinPayload, ChatMessage, ChatMessagePayload, ChatServer } from '../models/Message';

// Cuántos mensajes antiguos se envían al entrar en una sala
const HISTORY_LIMIT = 50;

// Longitud máxima de un mensaje (la misma que el maxlength del frontend y del modelo Message)
const MAX_TEXT_LENGTH = 2000;

// Usuarios conectados al chat: id del usuario -> cuántos sockets tiene abiertos.
// Se cuentan los sockets porque un usuario puede tener el chat abierto en dos pestañas:
// solo deja de estar conectado cuando cierra la última.
// Vive en memoria: si el servidor se reinicia, se vuelve a llenar con las reconexiones.
const onlineUsers = new Map<string, number>();

// Comprueba que la sala tiene uno de los nombres del contrato y que este usuario puede entrar:
//
//   general                 la sala de todos
//   group:<nombre>          una sala de grupo; entra quien conozca el nombre
//   direct:<idA>:<idB>      chat directo entre dos usuarios, con los ids ordenados
//                           (así los dos generan el mismo nombre). Solo entran esos dos usuarios.
//
// Sin esta comprobación, cualquiera podría escribir el nombre de un chat directo ajeno
// (los ids salen en GET /users) y leer su historial.
export const canJoinRoom = (room: string, userId: string): boolean => {
    if (room === 'general') {
        return true;
    }

    if (room.startsWith('group:')) {
        return room.length > 'group:'.length && room.length <= 100;
    }

    if (room.startsWith('direct:')) {
        const ids = room.slice('direct:'.length).split(':');

        return ids.length === 2 && ids[0] < ids[1] && ids.includes(userId);
    }

    return false;
};

// Engancha socket.io al mismo servidor HTTP que Express: la API y el chat comparten puerto.
//
// El flujo de un mensaje, de principio a fin:
//   1. El cliente se conecta enviando su token; VerifySocketToken lo comprueba.
//   2. El cliente emite chat:join con una sala; el servidor lo mete en ella (socket.join)
//      y le devuelve solo a él el historial (chat:history).
//   3. El cliente emite chat:message con la sala y el texto; el servidor lo guarda en MongoDB
//      y lo emite a todos los que están en esa sala (io.to(sala).emit), incluido quien lo escribió.
export const StartChat = (server: http.Server) => {
    const io: ChatServer = new Server(server, {
        cors: {
            origin: config.cors.origin,
            methods: ['GET', 'POST']
        }
    });

    io.use(VerifySocketToken);

    // Envía a todos los clientes la lista de usuarios conectados
    const emitOnlineUsers = () => io.emit('users:online', [...onlineUsers.keys()]);

    io.on('connection', (socket) => {
        // El middleware JWT ya comprobó la identidad antes de permitir esta conexión.
        const userId = socket.data.user.id;
        Logging.info(`Socket connected for user ${userId}`);

        // Apuntamos que está conectado y avisamos a todos (también al que acaba de entrar)
        onlineUsers.set(userId, (onlineUsers.get(userId) ?? 0) + 1);
        emitOnlineUsers();

        //================================
        socket.broadcast.emit('user:connected', { userId });
        //================================

        // El cliente pide entrar a una sala, por ejemplo "general".
        socket.on('chat:join', async (payload: ChatJoinPayload) => {
            // Los tipos de TypeScript no validan los datos que llegan por la red;
            // comprobamos también que la sala realmente sea un texto.
            if (!payload || typeof payload.room !== 'string' || payload.room.trim().length === 0) {
                socket.emit('chat:error', { message: 'La sala indicada no es válida.' });
                return;
            }

            const room = payload.room.trim();

            if (!canJoinRoom(room, userId)) {
                Logging.warning(`User ${userId} tried to join room ${room}`);
                socket.emit('chat:error', { message: 'No puedes entrar en esta sala.' });
                return;
            }

            try {
                // Socket.IO se encarga de añadir esta conexión a la sala.
                await socket.join(room);

                // Buscamos los mensajes más recientes y los ordenamos del más antiguo al más nuevo.
                const history = await Message.find({ room }).sort({ timestamp: -1 }).limit(HISTORY_LIMIT).populate('user', 'name').lean();

                // Devolvemos el historial solo a quien acaba de entrar, en orden cronológico.
                // El "as" es porque Mongoose no sabe que populate ha cambiado el id del usuario
                // por { _id, name }.
                socket.emit('chat:history', history.reverse() as unknown as ChatMessage[]);
            } catch (error) {
                // Registramos el fallo en el servidor y avisamos al cliente sin exponer detalles internos.
                Logging.error(error);
                socket.emit('chat:error', { message: 'No se pudo cargar el historial de la sala.' });
            }
        });

        // El cliente envía el mensaje y la sala donde quiere publicarlo.
        socket.on('chat:message', async (payload: ChatMessagePayload) => {
            // Los tipos de TypeScript no comprueban los datos que llegan desde la red.
            if (!payload || typeof payload.room !== 'string' || typeof payload.text !== 'string' || payload.room.trim().length === 0 || payload.text.trim().length === 0) {
                socket.emit('chat:error', { message: 'La sala y el texto del mensaje son obligatorios.' });
                return;
            }

            const room = payload.room.trim();
            const text = payload.text.trim();

            if (text.length > MAX_TEXT_LENGTH) {
                socket.emit('chat:error', { message: `El mensaje no puede tener más de ${MAX_TEXT_LENGTH} caracteres.` });
                return;
            }

            // Solo se permite escribir en salas a las que este socket ya se unió.
            // Como chat:join comprueba canJoinRoom, esto también impide escribir en un chat directo ajeno.
            if (!socket.rooms.has(room)) {
                socket.emit('chat:error', { message: 'Debes entrar a la sala antes de enviar mensajes.' });
                return;
            }

            try {
                // El autor sale del JWT verificado, nunca de los datos enviados por el cliente.
                const message = await Message.create({ room, user: userId, text });

                // Cargamos el nombre del autor para enviar datos parecidos a los del historial.
                await message.populate('user', 'name');

                // Se emite el mensaje ya guardado a todos los sockets conectados a esa sala.
                io.to(room).emit('chat:message', message.toJSON() as unknown as ChatMessage);
            } catch (error) {
                // El detalle queda en el log del servidor; al cliente solo le enviamos un aviso.
                Logging.error(error);
                socket.emit('chat:error', { message: 'No se pudo guardar el mensaje.' });
            }
        });

        // Dejamos registrado cuándo se desconecta un usuario.
        socket.on('disconnect', () => {
            Logging.info(`Socket disconnected for user ${userId}`);

            // Si era su último socket abierto, deja de estar conectado y avisamos a todos
            const sockets = (onlineUsers.get(userId) ?? 1) - 1;
            if (sockets > 0) {
                onlineUsers.set(userId, sockets);
            } else {
                onlineUsers.delete(userId);
                emitOnlineUsers();
                //================================
                socket.broadcast.emit('user:disconnected', { userId });
                //================================
            }
        });
    });

    return io;
};
