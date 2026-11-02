'use strict';
// Native menu callbacks ignore returned promises; handle persistence failures
// here so a failed action is reported instead of becoming an unhandled rejection.
function createMenuAction(action, report, onSuccess = () => {}) {
  return async () => {
    try { await action(); onSuccess(); return true; }
    catch (error) { report(error); return false; }
  };
}
module.exports = { createMenuAction };
