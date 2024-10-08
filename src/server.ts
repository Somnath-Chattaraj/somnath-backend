import WebSocket, { Server } from 'ws';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const wss = new Server({ port: 8080 });
let clientCount = 0;

// Map to track which rooms each client is in
const clientRoomMap = new Map<WebSocket, Set<number>>(); // WebSocket -> Set of room IDs

wss.on('connection', (ws) => {
  const clientId = ++clientCount; // Increment and get the client ID
  console.log(`Client${clientId} connected`);

  // Initialize client-room mapping
  clientRoomMap.set(ws, new Set());

  ws.on('message', async (message) => {
    const { type, data } = JSON.parse(message.toString()); // data will contain roomId, userId, targetUserId, and message
    // type will contain 'createRoom', 'joinRoom', 'sendMessage'
    
    switch (type) {
      case 'createRoom':
        try {
          // Create a new chat room
          const newRoom = await prisma.chatRoom.create({
            data: {
              users: {
                connect: [{ user_id: data.userId }, { user_id: data.targetUserId }]
              }
            }
          });

          // Update client-room mapping for new room
          // @ts-ignore: clientRoomMap is a Map<WebSocket, Set<number>>
          clientRoomMap.get(ws)?.add(newRoom.id);
          ws.send(JSON.stringify({ type: 'roomCreated', data: { roomId: newRoom.id } }));
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Failed to create or join chat room' } }));
        }
        break;

      case 'joinRoom':
        try {
          await prisma.chatRoom.update({
            where: { id: data.roomId },
            data: {
              users: {
                connect: [{ user_id: data.userId }]
              }
            }
          });

          // Update client-room mapping for the joined room
          const rooms = clientRoomMap.get(ws);
          rooms?.add(data.roomId);
          ws.send(JSON.stringify({ type: 'roomJoined', data: { roomId: data.roomId } }));

          // Notify other clients in the room about the new join
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client !== ws) {
              const clientRooms = clientRoomMap.get(client);
              if (clientRooms?.has(data.roomId)) {
                client.send(JSON.stringify({ type: 'newClientJoined', data: { roomId: data.roomId, message: `Client${clientId} joined` } }));
              }
            }
          });
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Failed to join chat room' } }));
        }
        break;

      case 'sendMessage':
        try {
          const newMessage = await prisma.message.create({
            data: {
              content: data.message,
              sender: { connect: { user_id: data.userId } },
              chatRoom: { connect: { id: data.roomId } },
            }
          });

          // Broadcast the message to all clients in the room
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              const rooms = clientRoomMap.get(client);
              if (rooms?.has(data.roomId)) {
                client.send(JSON.stringify({ type: 'newMessage', data: { roomId: data.roomId, message: newMessage } }));
              }
            }
          });
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Failed to send message' } }));
        }
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message type' } }));
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Client${clientId} disconnected`);

    // Retrieve the rooms the client was part of
    const rooms = clientRoomMap.get(ws);
    if (rooms) {
      rooms.forEach(roomId => {
        // Broadcast the disconnect message to all clients in the room
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client !== ws) {
            const clientRooms = clientRoomMap.get(client);
            if (clientRooms?.has(roomId)) {
              client.send(JSON.stringify({ type: 'clientDisconnected', data: { roomId, message: `Client${clientId} disconnected` } }));
            }
          }
        });
      });
    }

    // Remove client from all rooms
    clientRoomMap.delete(ws);
  });
});

export default wss;
