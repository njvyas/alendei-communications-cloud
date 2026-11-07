import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeliveryStatusBadge,
  ReadReceiptBadge,
  DeliveryOutcomeCell,
} from './delivery-status-badge';
import type { MessageDeliveryStatus } from '@/lib/api-client';

describe('DeliveryStatusBadge & ReadReceiptBadge (Phase 5.0 Two-Axis Delivery Model)', () => {
  it('1. DeliveryStatusBadge renders semantic badges across all valid delivery statuses', () => {
    // pending
    const pendingHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'pending' }),
    );
    assert.ok(pendingHtml.includes('PENDING'));
    assert.ok(pendingHtml.includes('data-delivery-status="pending"'));
    assert.ok(pendingHtml.includes('aria-label="Delivery status: Pending delivery"'));
    assert.ok(pendingHtml.includes('animate-pulse'));

    // delivered
    const deliveredHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'delivered' }),
    );
    assert.ok(deliveredHtml.includes('DELIVERED'));
    assert.ok(deliveredHtml.includes('data-delivery-status="delivered"'));
    assert.ok(deliveredHtml.includes('aria-label="Delivery status: Delivered"'));
    assert.ok(deliveredHtml.includes('text-emerald-400'));

    // undelivered
    const undeliveredHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'undelivered' }),
    );
    assert.ok(undeliveredHtml.includes('UNDELIVERED'));
    assert.ok(undeliveredHtml.includes('data-delivery-status="undelivered"'));
    assert.ok(undeliveredHtml.includes('aria-label="Delivery status: Undelivered"'));
    assert.ok(undeliveredHtml.includes('text-rose-400'));

    // not_supported
    const notSupportedHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'not_supported' }),
    );
    assert.ok(notSupportedHtml.includes('RECEIPTS N/A'));
    assert.ok(notSupportedHtml.includes('data-delivery-status="not_supported"'));
    assert.ok(notSupportedHtml.includes('aria-label="Delivery status: Receipts not supported"'));
  });

  it('2. DeliveryStatusBadge gracefully handles legacy records with NULL or undefined delivery status', () => {
    // null deliveryStatus (pre-Phase 5.0 legacy records)
    const nullHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: null }),
    );
    assert.ok(nullHtml.includes('NOT TRACKED'));
    assert.ok(nullHtml.includes('data-delivery-status="not_tracked"'));
    assert.ok(nullHtml.includes('aria-label="Delivery status: Not tracked"'));

    // undefined deliveryStatus
    const undefHtml = renderToStaticMarkup(React.createElement(DeliveryStatusBadge, {}));
    assert.ok(undefHtml.includes('NOT TRACKED'));
    assert.ok(undefHtml.includes('data-delivery-status="not_tracked"'));

    // unrecognized / corrupt deliveryStatus fallback
    const fallbackHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, {
        deliveryStatus: 'unknown_val' as unknown as MessageDeliveryStatus,
      }),
    );
    assert.ok(fallbackHtml.includes('NOT TRACKED'));
    assert.ok(fallbackHtml.includes('data-delivery-status="not_tracked"'));
  });

  it('3. ReadReceiptBadge renders read confirmation when readAt timestamp is present', () => {
    const timestamp = '2026-11-07T10:15:30.000Z';
    const html = renderToStaticMarkup(React.createElement(ReadReceiptBadge, { readAt: timestamp }));

    assert.ok(html.includes('READ'));
    assert.ok(html.includes('data-testid="read-receipt-badge"'));
    assert.ok(html.includes('aria-label="Read receipt: Confirmed at'));
    assert.ok(html.includes('text-cyan-400'));
  });

  it('4. ReadReceiptBadge renders nothing when readAt is null or undefined (read is an attribute, not an error)', () => {
    const nullHtml = renderToStaticMarkup(React.createElement(ReadReceiptBadge, { readAt: null }));
    assert.equal(nullHtml, '');

    const undefHtml = renderToStaticMarkup(React.createElement(ReadReceiptBadge, {}));
    assert.equal(undefHtml, '');
  });

  it('5. DeliveryOutcomeCell correctly renders combined delivery status, read receipt, and delivery timestamp', () => {
    const deliveredAt = '2026-11-07T10:14:00.000Z';
    const readAt = '2026-11-07T10:15:00.000Z';

    const html = renderToStaticMarkup(
      React.createElement(DeliveryOutcomeCell, {
        deliveryStatus: 'delivered',
        readAt,
        deliveredAt,
      }),
    );

    assert.ok(html.includes('DELIVERED'));
    assert.ok(html.includes('READ'));
    assert.ok(html.includes('data-testid="delivery-outcome-cell"'));
    assert.ok(html.includes('title="Delivered at:'));
  });

  it('6. Supports sm and md sizing correctly', () => {
    const smHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'delivered', size: 'sm' }),
    );
    assert.ok(smHtml.includes('text-[10px]'));

    const mdHtml = renderToStaticMarkup(
      React.createElement(DeliveryStatusBadge, { deliveryStatus: 'delivered', size: 'md' }),
    );
    assert.ok(mdHtml.includes('text-xs'));
  });
});
