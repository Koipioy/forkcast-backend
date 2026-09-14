'use strict';

const { ceilDiv, toSafeNumber } = require('./money');
const { PAYMENT_FEE_ESTIMATE } = require('./config');

function estimatePaymentFeeMicros(grossPaymentMicros) {
  const gross = toSafeNumber(grossPaymentMicros || 0, 'grossPaymentMicros');
  if (gross <= 0) return 0;
  const percentFee = ceilDiv(BigInt(gross) * BigInt(PAYMENT_FEE_ESTIMATE.percentBps), 10_000n);
  const fixedFee = BigInt(PAYMENT_FEE_ESTIMATE.fixedMicros || 0);
  return toSafeNumber(percentFee + fixedFee, 'paymentFeeMicros');
}

module.exports = {
  estimatePaymentFeeMicros,
};
