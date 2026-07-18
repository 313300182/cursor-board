function createBroadcaster() {
  const clients = new Set();
  const removeClient = (client) => {
    clients.delete(client);
  };
  return {
    add(res) {
      clients.add(res);
      res.once('close', () => removeClient(res));
      res.once('error', () => removeClient(res));
    },
    remove(res) {
      removeClient(res);
    },
    send(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        try {
          // 丢弃慢客户端，避免 Node 在其 writable buffer 中无限排队。
          if (!client.write(payload)) {
            removeClient(client);
            client.destroy();
          }
        } catch (_) {
          removeClient(client);
          try {
            client.destroy();
          } catch {
            // ignore
          }
        }
      }
    },
  };
}

module.exports = {
  createBroadcaster,
};
