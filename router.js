var events = require('events');
var util = require('util');
var underscore = require('underscore');
var dateformat = require("dateformat");

exports.serverSockets = [];

exports.Router = function() {
  var self = this;

  self.on("directionChange", function (isClient) {
    if (!isClient) {
      self.emit("registerServer");
    } else {
      self.emit("unregisterServer");
    }
  });

  self.stream.on("end", function () {
    self.emit("unregisterServer");
  });

  self.stream.on("error", function (err) {
    self.emit("unregisterServer");
  });

  self.on("registerServer", function (isClient) {
    exports.serverSockets[self.name] = self;
  });

  self.on("unregisterServer", function (isClient) {
    if (exports.serverSockets[self.name]) {
      delete exports.serverSockets[self.name];
    }
  });

  self.on('receiveCommand_WATCH', function (params) {
    // OpenCPN only send: { class: 'WATCH', nmea: true }
    if (typeof params.enable == 'undefined') {
      if (typeof params.nmea != 'undefined') {
        self.watch = params.nmea;
      }
      else if (typeof params.json != 'undefined') {
        self.watch = params.json;
      }
    }
    else {
      self.watch = params.enable;
    }
  });

  self.on('receiveCommand_REPLAY', function (params) {
    self.watch = true;
  });

  self.on('receiveResponse', function (response) {
    if (!response.time) {
      response.time = dateformat((new Date()), "isoDateTime");
    }
    for (var name in exports.serverSockets) {
      var serverSocket = exports.serverSockets[name];
      if (serverSocket.watch) {
        if (serverSocket.nmea) {
          serverSocket.responseConvertNmea(response);
        }
        else {
          serverSocket.sendResponse(response);
        }
      }
    }
  });


  self.emit("directionChange", self.isClient);

}
