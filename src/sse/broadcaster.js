function createBroadcaster() {
  const clients = new Set();
  return {
    add(res) {
      clients.add(res);
    },
    remove(res) {
      clients.delete(res);
    },
    send(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        client.write(payload);
      }
    },
  };
}

module.exports = {
  createBroadcaster,
};
