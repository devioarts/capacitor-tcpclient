(function () {
  var b = window._CapElectron;
  if (!b) return;

  var headers = b.getPluginHeaders();

  // Build CapacitorCustomPlatform.plugins shim so plugins using the old-style
  // electron factory (registerPlugin 'electron' key → CapacitorCustomPlatform.plugins.X)
  // work without any changes to their source.
  var plugins = {};
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i];
    var name = h.name;
    var bridge = {};
    var hasEvents = false;

    for (var j = 0; j < h.methods.length; j++) {
      var m = h.methods[j];
      if (m.rtype === 'callback') { hasEvents = true; continue; }
      (function (n, mn) {
        bridge[mn] = function (opts) { return b.invoke(n + '-' + mn, opts); };
      })(name, m.name);
    }

    if (hasEvents) {
      (function (n) {
        bridge['addListener'] = function (eventName, fn) {
          return b.nativeCallback(n, 'addListener', { eventName: eventName }, fn);
        };
        bridge['removeListener'] = function (callbackId) {
          b.nativeCallback(n, 'removeListener', { callbackId: callbackId }, undefined);
        };
        bridge['removeAllListeners'] = function (eventName) {
          b.nativeCallback(n, 'removeAllListeners', eventName ? { eventName: eventName } : undefined, undefined);
        };
      })(name);
    }

    plugins[name] = bridge;
  }

  window.CapacitorCustomPlatform = { name: 'electron', plugins: plugins };
  window.Capacitor = {
    PluginHeaders: headers,
    nativePromise: function (p, m, o) { return b.invoke(p + '-' + m, o); },
    nativeCallback: function (p, m, o, fn) { return b.nativeCallback(p, m, o, fn); },
  };
})();
