// 缓冲区膨胀到此阈值才判定客户端真正卡死并丢弃，避免内存无限排队。
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;

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
          client.write(payload);
          // write() 返回 false 只是 TCP 背压（缓冲超过 highWaterMark），数据仍会发出，
          // 不能据此判定客户端断开——否则日志高频刷屏时会误杀 SSE 连接，导致断连期间
          // 的状态变更事件丢失、看板卡片卡在旧状态。仅当缓冲真正膨胀时才丢弃。
          if (client.writableLength > MAX_BUFFERED_BYTES) {
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
