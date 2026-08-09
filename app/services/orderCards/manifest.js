const path = require('path');
const settings = require('../settings');
const { createOrderCardsRenderer } = require('./renderer');
const { createLegacyOrderListRuntime } = require('./legacyOrderListRuntime');

settings.register(
  'order-cards',
  path.join(__dirname, 'config', 'order-cards.json'),
  path.join(__dirname, 'config', 'order-cards-settings-descriptor.json')
);

const rendererHandlers = [{
  cardType: 'regular',
  register(context = {}) {
    const orderCardsRenderer = createOrderCardsRenderer(context.orderCardsDeps || {});
    const legacyOrderListRuntime = createLegacyOrderListRuntime({
      ...(context.legacyOrderListDeps || {}),
      matchesExistingOrderRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      orderCardHandlerForRow: (...args) => orderCardsRenderer.handlerFor(...args),
      orderCardHandlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      scheduleOrderCardInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args)
    });
    context.registerLegacyOrderCardsRuntime?.({
      runtime: legacyOrderListRuntime,
      createCard: (row, index) => orderCardsRenderer.createLegacyOrderCard({ row, index }),
      registerInstrumentHandler: (...args) => orderCardsRenderer.registerInstrumentHandler(...args),
      registerCardTypeHandler: (...args) => orderCardsRenderer.registerCardTypeHandler(...args),
      handlerFor: (...args) => orderCardsRenderer.handlerFor(...args),
      handlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      matchesExistingRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      scheduleInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args),
      place: (...args) => orderCardsRenderer.place(...args),
      instrumentTypeHandlers: orderCardsRenderer.instrumentTypeHandlers,
      cardTypeHandlers: orderCardsRenderer.cardTypeHandlers
    });

    const {
      positionKey,
      positionCardTitle,
      btn,
      dispatchPositionAction,
      requestRemovePosition
    } = context;
    if (!orderCardsRenderer?.createRegularPositionCard) return;
    context.registerPositionCardRenderer?.('regular', (position) => {
      return orderCardsRenderer.createRegularPositionCard({
        position,
        key: positionKey(position),
        title: positionCardTitle(position),
        createActionButton: ({ label, kind, className, onClick }) => {
          const button = btn(label, className, onClick);
          button.dataset.kind = kind;
          return button;
        },
        dispatchPositionAction,
        requestRemove: requestRemovePosition
      });
    });
  }
}];

function initService() {}

module.exports = { initService, rendererHandlers };
