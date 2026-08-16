function createLegacyRowPresentationAdapter({
  rowByKey,
  cardByKey,
  rowKey,
  stateApi,
  stateFacades,
  handlerForKey,
  ipcRenderer,
  render = () => {},
  toast = () => {},
  shakeCard = () => {},
  notifyCardRestored,
  updateSpreadForTicker
} = {}) {
  function findRowByKey(key) {
    if (typeof rowByKey !== 'function') return undefined;
    const rowOrRows = rowByKey(key);
    if (Array.isArray(rowOrRows) && typeof rowKey === 'function') {
      return rowOrRows.find(row => rowKey(row) === key);
    }
    return rowOrRows;
  }

  function restoreRemovedParts(card) {
    if (!card?._removedParts) return;
    for (const { node, next } of card._removedParts) {
      if (next && next.parentNode === card) card.insertBefore(node, next);
      else card.appendChild(node);
    }
    card._removedParts = null;
  }

  function collapseCard(card) {
    card.classList.add('card--mini');
    if (card._removedParts) return;
    card._removedParts = [];
    ['.meta', '.quad-line', '.extraRow', '.btns', '.card__note'].forEach(selector => {
      const node = card.querySelector(selector);
      if (!node) return;
      card._removedParts.push({ node, next: node.nextSibling });
      node.remove();
    });
  }

  function setCardState(key, stateName) {
    if (stateName) stateApi?.setCardState?.(key, stateName);
    else stateApi?.clearCardState?.(key);

    const card = cardByKey?.(key);
    if (!card) return;
    const cardHandler = handlerForKey?.(key);
    const status = card.querySelector('.card__status');
    const close = card.querySelector('.card__close');
    const retryBtn = card.querySelector('.retry-btn');
    const spreadEl = card.querySelector('.card__spread');
    let btnsWrap = card.querySelector('.btns');
    if (!status) return;

    const inputs = card.querySelectorAll('input');
    const buttons = card.querySelectorAll('button.btn');

    if (stateName) {
      status.style.display = 'inline-block';
      status.className = `card__status card__status--${stateName}`;
      if (stateName === 'pending-exec') {
        const label = stateApi?.getPendingExecLabel?.(key);
        status.textContent = label ? `pe (${label})` : 'pe';
      } else {
        stateApi?.clearPendingExecLabel?.(key);
        status.textContent = '';
      }
      card.classList.toggle('card--pending', stateName === 'pending' || stateName === 'pending-exec');
      if (close) close.style.display = 'none';
      if (spreadEl) spreadEl.style.display = 'none';
      inputs.forEach(input => { input.disabled = true; });
      buttons.forEach(button => { button.disabled = true; });
      if (btnsWrap) btnsWrap.style.display = stateName === 'pending-exec' ? 'none' : '';

      const closePlacedOrder = async () => {
        const orderInfo = stateApi?.getPlacedOrder?.(key);
        const currentRow = findRowByKey(key);
        if (typeof cardHandler?.closePlacedOrder === 'function') {
          const handled = await cardHandler.closePlacedOrder({
            key,
            row: currentRow,
            orderInfo,
            pendingRequestLabels: stateFacades?.pendingRequestLabels,
            placedOrderLookup: stateFacades?.placedOrderLookup,
            cardVisualState: stateFacades?.cardVisualState,
            ticketBinding: stateFacades?.ticketBinding,
            setCardState,
            render,
            ipcRenderer,
            toast,
            shakeCard
          });
          if (handled) return;
        }
        if (orderInfo && orderInfo.ticket && orderInfo.provider) {
          await ipcRenderer?.invoke?.('execution:cancel-order', {
            provider: orderInfo.provider,
            ticket: orderInfo.ticket,
            symbol: orderInfo.symbol,
            name: orderInfo.name || currentRow?.name
          }).catch(() => null);
        }
        stateApi?.clearExecutionStateByKey?.(key);
        setCardState(key, null);
        render();
      };

      if (stateName === 'placed') {
        status.style.cursor = 'pointer';
        status.title = cardHandler?.placedStatusTitle || 'Return to ready to send';
        status.onclick = closePlacedOrder;
        if (cardHandler?.placedButton && btnsWrap) {
          const closeBtn = btnsWrap.querySelector('button.btn');
          if (closeBtn) {
            const replacement = closeBtn.cloneNode(true);
            replacement.textContent = cardHandler.placedButton.label || closeBtn.textContent;
            for (const className of cardHandler.placedButton.removeClasses || []) {
              replacement.classList.remove(className);
            }
            for (const className of cardHandler.placedButton.addClasses || []) {
              replacement.classList.add(className);
            }
            replacement.disabled = false;
            replacement.title = cardHandler.placedButton.title || status.title;
            replacement.addEventListener('click', closePlacedOrder);
            closeBtn.replaceWith(replacement);
          }
        }
      } else if (stateName === 'pending-exec') {
        status.style.cursor = 'pointer';
        status.title = 'Cancel pe';
        status.onclick = () => {
          const reqId = card.dataset.reqId;
          const pendingId = card.dataset.pendingId || (reqId ? stateApi?.getPendingId?.(reqId) : null);
          if (pendingId) ipcRenderer?.invoke?.('pending:cancel', pendingId).catch(() => {});
          if (reqId) {
            stateApi?.clearPendingRequest?.(reqId);
            delete card.dataset.reqId;
          }
          delete card.dataset.pendingId;
          setCardState(key, null);
          render();
        };
      } else {
        status.style.cursor = '';
        status.title = '';
        status.onclick = null;
        card.style.cursor = '';
        card.title = '';
        card.onclick = null;
      }

      const keepFullCard = stateName === 'pending'
        || stateName === 'pending-exec'
        || !!cardHandler?.shouldKeepFullCardOnState?.({ state: stateName, key, card });
      if (keepFullCard) {
        card.classList.remove('card--mini');
        restoreRemovedParts(card);
        btnsWrap = card.querySelector('.btns');
        card.querySelectorAll('input').forEach(input => { input.disabled = true; });
        card.querySelectorAll('button.btn').forEach(button => {
          button.disabled = !cardHandler?.shouldEnableButtonOnState?.({ state: stateName, key, card });
        });
        if (btnsWrap && cardHandler?.shouldHideButtonsOnState?.({ state: stateName, key, card })) {
          btnsWrap.style.display = 'none';
        }
        if (retryBtn) {
          if (stateName === 'pending') {
            retryBtn.style.display = 'inline-block';
            const reqId = card.dataset.reqId;
            const retryCount = reqId ? stateApi?.getRetryCount?.(reqId) : undefined;
            if (retryCount != null) retryBtn.textContent = String(retryCount);
          } else {
            retryBtn.style.display = 'none';
          }
        }
      } else {
        collapseCard(card);
        if (retryBtn) retryBtn.style.display = 'none';
      }
      return;
    }

    card.classList.remove('card--mini');
    status.style.display = 'none';
    status.textContent = '';
    stateApi?.clearPendingExecLabel?.(key);
    status.style.cursor = '';
    status.title = '';
    status.onclick = null;
    card.style.cursor = '';
    card.title = '';
    card.onclick = null;
    card.classList.remove('card--pending');
    if (spreadEl) spreadEl.style.display = '';
    notifyCardRestored?.({ card, updateSpreadForTicker });
    if (close) close.style.display = '';
    restoreRemovedParts(card);
    card.querySelectorAll('input').forEach(input => { input.disabled = false; });
    card.querySelectorAll('button.btn').forEach(button => { button.disabled = false; });
    btnsWrap = card.querySelector('.btns');
    if (btnsWrap) btnsWrap.style.display = '';
    if (cardHandler?.resetButtons && btnsWrap) {
      const openBtn = btnsWrap.querySelector('button.btn');
      if (openBtn) cardHandler.resetButtons(openBtn);
    }
    if (retryBtn) retryBtn.style.display = 'none';
    stateApi?.deletePlacedOrder?.(key);
  }

  return { setCardState };
}

module.exports = { createLegacyRowPresentationAdapter };
