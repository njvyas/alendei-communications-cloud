import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { toast } from './toast';

describe('toast store (U6)', () => {
  beforeEach(() => {
    toast.clear();
  });

  it('1. adds success, error, and info toasts', () => {
    const id1 = toast.success('Operation Successful', 'Data has been saved.');
    assert.ok(id1.startsWith('toast-'));

    let current = toast.getToasts();
    assert.equal(current.length, 1);
    assert.equal(current[0]!.type, 'success');
    assert.equal(current[0]!.title, 'Operation Successful');
    assert.equal(current[0]!.message, 'Data has been saved.');

    const id2 = toast.error('Action Failed', 'Could not connect to service.');
    current = toast.getToasts();
    assert.equal(current.length, 2);
    assert.equal(current[1]!.id, id2);
    assert.equal(current[1]!.type, 'error');

    const id3 = toast.info('Notice', 'System maintenance scheduled.');
    current = toast.getToasts();
    assert.equal(current.length, 3);
    assert.equal(current[2]!.id, id3);
    assert.equal(current[2]!.type, 'info');
  });

  it('2. dismisses toast by id', () => {
    const id1 = toast.success('Toast 1');
    const id2 = toast.success('Toast 2');
    assert.equal(toast.getToasts().length, 2);

    toast.dismiss(id1);
    const remaining = toast.getToasts();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, id2);
  });

  it('3. clear() removes all active toasts', () => {
    toast.success('Toast 1');
    toast.error('Toast 2');
    toast.info('Toast 3');
    assert.equal(toast.getToasts().length, 3);

    toast.clear();
    assert.equal(toast.getToasts().length, 0);
  });

  it('4. caps maximum visible toasts at 5 and drops oldest', () => {
    toast.success('T1');
    toast.success('T2');
    toast.success('T3');
    toast.success('T4');
    toast.success('T5');
    assert.equal(toast.getToasts().length, 5);
    assert.equal(toast.getToasts()[0]!.title, 'T1');

    toast.success('T6');
    const toasts = toast.getToasts();
    assert.equal(toasts.length, 5);
    assert.equal(toasts[0]!.title, 'T2');
    assert.equal(toasts[4]!.title, 'T6');
  });

  it('5. auto-dismisses toast after duration expires', async () => {
    toast.success('Expiring Toast', undefined, { duration: 50 });
    assert.equal(toast.getToasts().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(toast.getToasts().length, 0);
  });

  it('6. persistent toast with duration 0 does not auto-dismiss', async () => {
    toast.success('Persistent Toast', undefined, { duration: 0 });
    assert.equal(toast.getToasts().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(toast.getToasts().length, 1);
  });
});
