import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUSABLE_SELECTOR,
  attachModalKeyboard,
  createDialogStack,
  isExpandedNativeSelect,
  focusInitialElement,
  getFocusableElements,
  handleDialogKeyDown,
  resolveTabTarget,
  restoreFocus,
  type DialogContainerLike,
  type DialogKeyEventLike,
} from './dialog-focus';

/**
 * Behavioural tests for modal focus management (U10). The DOM is modelled with
 * small fakes that record focus, so the tests exercise the real keyboard
 * handling used by AccessibleDialog / useModalDialog without a browser.
 */

interface FakeDocument {
  activeElement: FakeElement | null;
}

class FakeElement {
  isConnected = true;
  constructor(
    readonly name: string,
    private readonly doc: FakeDocument,
    private readonly attrs: Record<string, string> = {},
  ) {}
  focus(): void {
    this.doc.activeElement = this;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

class FakeContainer implements DialogContainerLike<FakeElement> {
  readonly selectors: string[] = [];
  constructor(
    private readonly doc: FakeDocument,
    readonly children: FakeElement[],
  ) {}
  querySelectorAll(selector: string): FakeElement[] {
    this.selectors.push(selector);
    if (selector === '[data-autofocus]') {
      return this.children.filter((c) => c.hasAttribute('data-autofocus'));
    }
    return this.children;
  }
  contains(node: unknown): boolean {
    return node === this || this.children.includes(node as FakeElement);
  }
  focus(): void {
    this.doc.activeElement = this as unknown as FakeElement;
  }
}

function keyEvent(key: string, shiftKey = false) {
  const event = {
    key,
    shiftKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
  };
  return event satisfies DialogKeyEventLike;
}

function buildDialog() {
  const doc: FakeDocument = { activeElement: null };
  const trigger = new FakeElement('trigger', doc);
  const close = new FakeElement('close', doc);
  const input = new FakeElement('input', doc);
  const disabled = new FakeElement('disabled-submit', doc, { disabled: '' });
  const cancel = new FakeElement('cancel', doc);
  const confirm = new FakeElement('confirm', doc);
  const container = new FakeContainer(doc, [close, input, disabled, cancel, confirm]);
  return { doc, trigger, close, input, disabled, cancel, confirm, container };
}

const noDismiss = { dismissible: true, onDismiss: () => assert.fail('must not dismiss') };

describe('U10 dialog focus containment (Tab / Shift+Tab)', () => {
  it('wraps Tab from the last focusable element to the first', () => {
    const d = buildDialog();
    d.confirm.focus();
    const e = keyEvent('Tab');
    const outcome = handleDialogKeyDown(e, d.container, d.doc.activeElement, noDismiss);
    assert.equal(outcome, 'focus-moved');
    assert.equal(d.doc.activeElement, d.close);
    assert.equal(e.defaultPrevented, true);
  });

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    const d = buildDialog();
    d.close.focus();
    const e = keyEvent('Tab', true);
    handleDialogKeyDown(e, d.container, d.doc.activeElement, noDismiss);
    assert.equal(d.doc.activeElement, d.confirm);
    assert.equal(e.defaultPrevented, true);
  });

  it('leaves Tab between inner elements to the browser', () => {
    const d = buildDialog();
    d.input.focus();
    const e = keyEvent('Tab');
    const outcome = handleDialogKeyDown(e, d.container, d.doc.activeElement, noDismiss);
    assert.equal(outcome, 'ignored');
    assert.equal(e.defaultPrevented, false);
    assert.equal(d.doc.activeElement, d.input);
  });

  it('pulls focus back into the dialog when it has escaped (Tab → first, Shift+Tab → last)', () => {
    const d = buildDialog();
    d.trigger.focus();
    handleDialogKeyDown(keyEvent('Tab'), d.container, d.doc.activeElement, noDismiss);
    assert.equal(d.doc.activeElement, d.close);

    d.trigger.focus();
    handleDialogKeyDown(keyEvent('Tab', true), d.container, d.doc.activeElement, noDismiss);
    assert.equal(d.doc.activeElement, d.confirm);
  });

  it('treats focus on the dialog container itself as outside the tab sequence', () => {
    const d = buildDialog();
    d.container.focus();
    handleDialogKeyDown(keyEvent('Tab'), d.container, d.doc.activeElement, noDismiss);
    assert.equal(d.doc.activeElement, d.close);
  });

  it('skips disabled controls when computing the tab boundaries', () => {
    const d = buildDialog();
    const focusables = getFocusableElements(d.container);
    assert.deepEqual(
      focusables.map((f) => f.name),
      ['close', 'input', 'cancel', 'confirm'],
    );
    assert.ok(d.container.selectors.includes(FOCUSABLE_SELECTOR));
  });

  it('keeps focus on the container when the dialog has no focusable controls', () => {
    const doc: FakeDocument = { activeElement: null };
    const container = new FakeContainer(doc, []);
    const e = keyEvent('Tab');
    handleDialogKeyDown(e, container, null, noDismiss);
    assert.equal(doc.activeElement, container as unknown as FakeElement);
    assert.equal(e.defaultPrevented, true);
  });

  it('stops Tab propagation so an enclosing handler cannot move focus out', () => {
    const d = buildDialog();
    d.input.focus();
    const e = keyEvent('Tab');
    handleDialogKeyDown(e, d.container, d.doc.activeElement, noDismiss);
    assert.equal(e.propagationStopped, true);
  });

  it('resolveTabTarget returns null for an empty list', () => {
    assert.equal(resolveTabTarget([], null, false, false), null);
  });
});

describe('U10 dialog Escape dismissal', () => {
  it('dismisses on Escape when dismissal is permitted', () => {
    const d = buildDialog();
    let dismissed = 0;
    const e = keyEvent('Escape');
    const outcome = handleDialogKeyDown(e, d.container, d.input, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    assert.equal(outcome, 'dismissed');
    assert.equal(dismissed, 1);
    assert.equal(e.propagationStopped, true, 'outer dialogs must not also close');
  });

  it('does not dismiss on Escape while dismissal is blocked (e.g. mutation in flight)', () => {
    const d = buildDialog();
    let dismissed = 0;
    const e = keyEvent('Escape');
    const outcome = handleDialogKeyDown(e, d.container, d.input, {
      dismissible: false,
      onDismiss: () => dismissed++,
    });
    assert.equal(outcome, 'dismiss-blocked');
    assert.equal(dismissed, 0);
    assert.equal(e.propagationStopped, true);
  });

  it('ignores unrelated keys', () => {
    const d = buildDialog();
    const e = keyEvent('Enter');
    assert.equal(handleDialogKeyDown(e, d.container, d.input, noDismiss), 'ignored');
    assert.equal(e.defaultPrevented, false);
    assert.equal(e.propagationStopped, false);
  });
});

describe('U10 dialog initial focus and focus restoration', () => {
  it('focuses the first enabled control when the dialog opens', () => {
    const d = buildDialog();
    d.trigger.focus();
    focusInitialElement(d.container);
    assert.equal(d.doc.activeElement, d.close);
  });

  it('prefers an element marked data-autofocus', () => {
    const doc: FakeDocument = { activeElement: null };
    const first = new FakeElement('first', doc);
    const preferred = new FakeElement('preferred', doc, { 'data-autofocus': '' });
    focusInitialElement(new FakeContainer(doc, [first, preferred]));
    assert.equal(doc.activeElement, preferred);
  });

  it('focuses the panel itself when every child control is disabled', () => {
    const doc: FakeDocument = { activeElement: null };
    const container = new FakeContainer(doc, [
      new FakeElement('save', doc, { disabled: '' }),
      new FakeElement('cancel', doc, { disabled: '' }),
    ]);
    focusInitialElement(container);
    assert.equal(doc.activeElement, container as unknown as FakeElement);
  });

  it('focuses the container when there is nothing focusable', () => {
    const doc: FakeDocument = { activeElement: null };
    const container = new FakeContainer(doc, []);
    focusInitialElement(container);
    assert.equal(doc.activeElement, container as unknown as FakeElement);
  });

  it('returns focus to the triggering element after dismissal', () => {
    const d = buildDialog();
    d.trigger.focus();
    const previous = d.doc.activeElement;
    focusInitialElement(d.container);
    assert.equal(d.doc.activeElement, d.close);

    handleDialogKeyDown(keyEvent('Escape'), d.container, d.doc.activeElement, {
      dismissible: true,
      onDismiss: () => restoreFocus(previous),
    });
    assert.equal(d.doc.activeElement, d.trigger);
  });

  it('does not restore focus to a trigger that has left the document', () => {
    const d = buildDialog();
    d.trigger.isConnected = false;
    d.input.focus();
    assert.equal(restoreFocus(d.trigger), false);
    assert.equal(d.doc.activeElement, d.input);
  });

  it('tolerates a missing previous element', () => {
    assert.equal(restoreFocus(null), false);
    assert.equal(restoreFocus(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// Global (document-level) keyboard handling, using a real Node EventTarget.
// ---------------------------------------------------------------------------

function dispatchKey(target: EventTarget, key: string, shiftKey = false): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
  });
  target.dispatchEvent(event);
  return event;
}

function openDialog(
  target: EventTarget,
  stack: ReturnType<typeof createDialogStack>,
  d: ReturnType<typeof buildDialog>,
  options: { dismissible: boolean; onDismiss: () => void },
) {
  return attachModalKeyboard({
    target: target as unknown as Parameters<typeof attachModalKeyboard>[0]['target'],
    stack,
    getContainer: () => d.container,
    getActiveElement: () => d.doc.activeElement,
    getOptions: () => options,
  });
}

describe('U10 global keydown handling (focus outside the dialog subtree)', () => {
  it('Tab and Shift+Tab pull focus back into the dialog from outside', () => {
    const target = new EventTarget();
    const d = buildDialog();
    const detach = openDialog(target, createDialogStack(), d, noDismiss);

    d.trigger.focus();
    const tab = dispatchKey(target, 'Tab');
    assert.equal(d.doc.activeElement, d.close);
    assert.equal(tab.defaultPrevented, true);

    d.trigger.focus();
    dispatchKey(target, 'Tab', true);
    assert.equal(d.doc.activeElement, d.confirm);
    detach();
  });

  it('Tab and Shift+Tab wrap at the dialog boundaries', () => {
    const target = new EventTarget();
    const d = buildDialog();
    const detach = openDialog(target, createDialogStack(), d, noDismiss);
    d.confirm.focus();
    dispatchKey(target, 'Tab');
    assert.equal(d.doc.activeElement, d.close);
    dispatchKey(target, 'Tab', true);
    assert.equal(d.doc.activeElement, d.confirm);
    detach();
  });

  it('Escape dismisses the dialog while focus is outside it', () => {
    const target = new EventTarget();
    const d = buildDialog();
    let dismissed = 0;
    const detach = openDialog(target, createDialogStack(), d, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    d.trigger.focus();
    const esc = dispatchKey(target, 'Escape');
    assert.equal(dismissed, 1);
    assert.equal(esc.defaultPrevented, true);
    detach();
  });

  it('Escape is blocked while a submission is in progress, and works once it ends', () => {
    const target = new EventTarget();
    const d = buildDialog();
    let dismissed = 0;
    const options = { dismissible: false, onDismiss: () => dismissed++ };
    const detach = openDialog(target, createDialogStack(), d, options);
    d.input.focus();
    dispatchKey(target, 'Escape');
    assert.equal(dismissed, 0, 'must not close while saving');
    options.dismissible = true;
    dispatchKey(target, 'Escape');
    assert.equal(dismissed, 1);
    detach();
  });

  it('only the topmost of nested dialogs handles Escape and Tab', () => {
    const target = new EventTarget();
    const stack = createDialogStack();
    const outer = buildDialog();
    const inner = buildDialog();
    const dismissed: string[] = [];
    const detachOuter = openDialog(target, stack, outer, {
      dismissible: true,
      onDismiss: () => dismissed.push('outer'),
    });
    const detachInner = openDialog(target, stack, inner, {
      dismissible: true,
      onDismiss: () => dismissed.push('inner'),
    });

    inner.confirm.focus();
    dispatchKey(target, 'Tab');
    assert.equal(inner.doc.activeElement, inner.close, 'inner dialog contains Tab');
    assert.equal(outer.doc.activeElement, null, 'outer dialog did not move focus');

    dispatchKey(target, 'Escape');
    assert.deepEqual(dismissed, ['inner']);

    detachInner();
    dispatchKey(target, 'Escape');
    assert.deepEqual(dismissed, ['inner', 'outer'], 'outer responds once inner has closed');
    detachOuter();
  });

  it('stops propagation of handled keys so page-level listeners do not also act', () => {
    const target = new EventTarget();
    const d = buildDialog();
    const detach = openDialog(target, createDialogStack(), d, {
      dismissible: true,
      onDismiss: () => {},
    });
    const esc = dispatchKey(target, 'Escape');
    assert.equal(esc.cancelBubble, true);
    const enter = dispatchKey(target, 'Enter');
    assert.equal(enter.cancelBubble, false, 'unrelated keys are left alone');
    detach();
  });

  it('removes its listener and stack entry on close/unmount', () => {
    const target = new EventTarget();
    const stack = createDialogStack();
    const d = buildDialog();
    let dismissed = 0;
    const detach = openDialog(target, stack, d, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    assert.equal(stack.size, 1);
    detach();
    assert.equal(stack.size, 0);
    d.trigger.focus();
    dispatchKey(target, 'Escape');
    dispatchKey(target, 'Tab');
    assert.equal(dismissed, 0, 'no handling after cleanup');
    assert.equal(d.doc.activeElement, d.trigger, 'focus no longer trapped after cleanup');
  });

  it('keeps the remaining dialog active when dialogs close out of order', () => {
    const target = new EventTarget();
    const stack = createDialogStack();
    const a = buildDialog();
    const b = buildDialog();
    const dismissed: string[] = [];
    const detachA = openDialog(target, stack, a, {
      dismissible: true,
      onDismiss: () => dismissed.push('a'),
    });
    const detachB = openDialog(target, stack, b, {
      dismissible: true,
      onDismiss: () => dismissed.push('b'),
    });
    detachA();
    dispatchKey(target, 'Escape');
    assert.deepEqual(dismissed, ['b']);
    detachB();
    assert.equal(stack.size, 0);
  });
});

describe('U10 Escape with native <select> pickers (Firefox 155 defect)', () => {
  function fakeSelect(state: 'open' | 'closed' | 'unsupported') {
    return {
      tagName: 'SELECT',
      matches(selector: string) {
        if (selector !== ':open') return false;
        if (state === 'unsupported') throw new SyntaxError("':open' is not a valid selector");
        return state === 'open';
      },
    };
  }

  function escapeFrom(target: unknown) {
    return Object.assign(keyEvent('Escape'), { target });
  }

  it('leaves Escape to an expanded native picker: no dismissal, default or propagation change', () => {
    const d = buildDialog();
    const select = fakeSelect('open');
    let dismissed = 0;
    const e = escapeFrom(select);
    const outcome = handleDialogKeyDown(e, d.container, select, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    assert.equal(outcome, 'deferred-to-native-popup');
    assert.equal(dismissed, 0);
    assert.equal(e.defaultPrevented, false, 'the browser must still collapse the picker');
    assert.equal(e.propagationStopped, false);
  });

  it('dismisses on Escape when the select is collapsed', () => {
    const d = buildDialog();
    const select = fakeSelect('closed');
    let dismissed = 0;
    const outcome = handleDialogKeyDown(escapeFrom(select), d.container, select, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    assert.equal(outcome, 'dismissed');
    assert.equal(dismissed, 1);
  });

  it('keeps the previous behaviour where :open is unsupported', () => {
    const d = buildDialog();
    const select = fakeSelect('unsupported');
    let dismissed = 0;
    handleDialogKeyDown(escapeFrom(select), d.container, select, {
      dismissible: true,
      onDismiss: () => dismissed++,
    });
    assert.equal(dismissed, 1);
  });

  it('only treats SELECT elements as native pickers', () => {
    const openDetails = { tagName: 'DETAILS', matches: (sel: string) => sel === ':open' };
    assert.equal(isExpandedNativeSelect(openDetails), false);
    assert.equal(isExpandedNativeSelect(fakeSelect('open')), true);
    assert.equal(isExpandedNativeSelect(null), false);
    assert.equal(isExpandedNativeSelect({}), false);
  });

  it('defers via the global listener too, then dismisses on the next Escape', () => {
    const target = new EventTarget();
    const d = buildDialog();
    let open = true;
    const select = { tagName: 'SELECT', matches: (sel: string) => sel === ':open' && open };
    let dismissed = 0;
    const detach = attachModalKeyboard({
      target: target as unknown as Parameters<typeof attachModalKeyboard>[0]['target'],
      stack: createDialogStack(),
      getContainer: () => d.container,
      getActiveElement: () => select,
      getOptions: () => ({ dismissible: true, onDismiss: () => dismissed++ }),
    });
    dispatchKey(target, 'Escape');
    assert.equal(dismissed, 0, 'first Escape collapses the picker only');
    open = false; // the browser collapsed it
    dispatchKey(target, 'Escape');
    assert.equal(dismissed, 1, 'second Escape closes the dialog');
    detach();
  });
});
