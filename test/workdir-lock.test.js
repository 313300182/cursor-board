const assert = require('node:assert/strict');
const test = require('node:test');

const WorkdirLock = require('../workdir-lock');

test('tryAcquire 冲突时失败，释放后可再次获取', () => {
  const lock = new WorkdirLock();
  assert.equal(lock.tryAcquire('a', ['D:\\repo\\app']), true);
  assert.equal(lock.tryAcquire('b', ['D:/repo/app/']), false);
  assert.equal(lock.isBusy(['D:\\repo\\app'], 'b'), true);
  lock.release('a');
  assert.equal(lock.tryAcquire('b', ['D:\\repo\\app']), true);
});

test('父子目录视为重叠', () => {
  const lock = new WorkdirLock();
  lock.tryAcquire('parent', ['D:\\repo']);
  assert.equal(lock.tryAcquire('child', ['D:\\repo\\app']), false);
  lock.release('parent');
  assert.equal(lock.tryAcquire('child', ['D:\\repo\\app']), true);
});

test('同一 owner 重复获取幂等（不与自身冲突）', () => {
  const lock = new WorkdirLock();
  assert.equal(lock.tryAcquire('a', ['D:\\repo\\app']), true);
  assert.equal(lock.tryAcquire('a', ['D:\\repo\\app']), true);
  assert.equal(lock.isBusy(['D:\\repo\\app'], 'a'), false);
});

test('无目录时视为不冲突', () => {
  const lock = new WorkdirLock();
  assert.equal(lock.tryAcquire('a', []), true);
  assert.equal(lock.isBusy([], 'b'), false);
});

test('阻塞 acquire 在释放后按 FIFO 被授予', async () => {
  const lock = new WorkdirLock();
  await lock.acquire('a', ['D:\\repo\\app']);

  const order = [];
  const p1 = lock.acquire('b', ['D:\\repo\\app']).then(() => order.push('b'));
  const p2 = lock.acquire('c', ['D:\\repo\\app']).then(() => order.push('c'));
  assert.equal(lock.waiterCount, 2);

  lock.release('a');
  await p1;
  assert.deepEqual(order, ['b']);
  assert.equal(lock.waiterCount, 1);

  lock.release('b');
  await p2;
  assert.deepEqual(order, ['b', 'c']);
});

test('release 会丢弃同 owner 的待获取请求（取消场景）', async () => {
  const lock = new WorkdirLock();
  await lock.acquire('holder', ['D:\\repo\\app']);
  const waiting = lock.acquire('waiter', ['D:\\repo\\app']);
  const rejected = waiting.then(() => 'resolved', (err) => `rejected:${err.message}`);
  lock.release('waiter');
  const outcome = await rejected;
  assert.match(outcome, /^rejected:/);
  assert.equal(lock.waiterCount, 0);
});

test('onRelease 监听器在每次释放后触发', () => {
  const lock = new WorkdirLock();
  let count = 0;
  lock.onRelease(() => { count += 1; });
  lock.tryAcquire('a', ['D:\\repo\\app']);
  lock.release('a');
  assert.equal(count, 1);
});
