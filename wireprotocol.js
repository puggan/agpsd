var events = require('events');
var util = require('util');
var underscore = require('underscore');
var dateformat = require("dateformat");
var argv = require("./argvparser");
var os = require("os");

exports.WireProtocol = function(stream, isClient, reverseRoles) {
  var self = this;
  events.EventEmitter.call(self);

  self.isClient = isClient;
  self.closed = false;
  self.data = "";
  self.stream = stream;
  self.nmea = false;

  var remote = self.stream.remoteAddress;
  if (remote == "127.0.0.1" || remote == "localhost") {
    remote = os.hostname();
  }
  var remotePort = self.stream.remotePort;
  if (remotePort != 4711) {
    remote += ":" + remotePort;
  }
  self.name = remote;

  if (argv.options.verbose && underscore.include(argv.options.verbose, 'connect')) {
    console.log("Connection opened from " + self.name);
  }

  stream.on("error", function (err) {
    console.log([self.name, err]);
    self.closed = true;
  });

  stream.on("end", function () {
    if (argv.options.verbose && underscore.include(argv.options.verbose, 'disconnect')) {
      console.log("Connection ended from " + self.name);
    }
    self.closed = true;
  });

  stream.on("close", function () {
    if (argv.options.verbose && underscore.include(argv.options.verbose, 'disconnect')) {
      console.log("Connection closed from " + self.name);
    }
    self.closed = true;
  });

  self.sendCommand = function (cmd, params) {
    self.stream.write("?" + cmd + "=" + JSON.stringify(params) + "\n");
  };

  self.sendResponse = function (data) {
    if (self.closed) return;
    //if (data.device) data.device = "/agpsd";
    data = JSON.stringify(data) + "\r\n";
    // console.log("S>" + data + "<");
    self.stream.write(data, function (err) {
      if (err) {
        console.error(err);
        self.stream.emit("end");
      }
    });
  };

  self.stream.on('data', function(data) {
    self.data += data + '\r\n';
    try {
      var _terminator = /^([^\r\n]*[\r\n]+)/;
      var rows = 0;
      while (results = _terminator.exec(self.data)) {
        rows++;
        var line = results[1];
        self.data = self.data.slice(line.length);
        if (line.indexOf("?") == 0) {
          line = line.match(/\?([^=]*)\=(.*[^;\r\n])/);
          var cmd =  line[1];
          var args = JSON.parse(line[2]);
          if (argv.options.verbose && underscore.include(argv.options.verbose, 'data')) {
            console.log(["C", cmd, args]);
          }
          self.emit('receiveCommand', cmd, args);
        } else {
          line = line.match(/(.*[^;\r\n]);?/)[1];
          var response = JSON.parse(line);
          if (argv.options.verbose && underscore.include(argv.options.verbose, 'data')) {
            console.log(["R", response]);
          }
          self.emit('mangleResponse', response);
          self.emit('receiveResponse', response);
        }
      };
      if(!rows && argv.options.verbose && underscore.include(argv.options.verbose, 'data')) {
        console.log({'recived rows': rows});
      }
    } catch (e) {
      console.log("Protocol error: " + e.toString());
      console.log(e.stack);
      self.closed = true;
      self.stream.end()
    }
  });

  self.on('directionChange', function (isClient) {
    self.isClient = isClient;
  });

  self.on('mangleResponse', function (response) {
    if (!response.time) {
      response.time = dateformat((new Date()), "isoDateTime");
    }
    if (response.device && response.device.indexOf("://") == -1) {
      response.device = "agpsd://" + self.name + response.device;
    }
    if (response.path && response.path.indexOf("://") == -1) {
      response.path = "agpsd://" + self.name + response.path;
    }
    if (response.devices) {
      response.devices.map(function (device) {
        if (device.path && device.path.indexOf("://") == -1) {
          device.path = "agpsd://" + self.name + device.path;
        }

      });
    }
    // Yes, for some reason gpsd doesn't do this for us...
    if (response.class == "AIS" && !response.ais_coord_float) {
      response.lat = response.lat / 600000.0;
      response.lon = response.lon / 600000.0;
      response.ais_coord_float = true;
    }
  });

  self.on('receiveResponse', function (data) {
    process.stdout.write(".");
    if (data.class) {
      self.emit('receiveResponse_' + data.class, data);
    }
  });

  self.on('receiveResponse_VERSION', function (data) {
    if (reverseRoles) {
      if (data.capabilities && underscore.include(data.capabilities, 'reverseroles')) {
        self.sendCommand("REVERSEROLES", {});
      } else {
        console.log("Role reversal not supported for " + self.name);
        self.closed = true;
        self.stream.end()
      }
    } else {
      if (data.capabilities && underscore.include(data.capabilities, 'replay')) {
        self.emit('receiveResponse_VERSION_REPLAY', data);
      } else {
        self.emit('receiveResponse_VERSION_WATCH', data);
      }
    }
  });

  self.on('receiveResponse_VERSION_WATCH', function (data) {
    self.sendCommand("WATCH", {"enable":true,"json":true});
  });

  self.on('receiveCommand', function (cmd, params) {
    self.emit('receiveCommand_' + cmd, params);
  });

  self.on('receiveCommand_REVERSEROLES', function (params) {
    self.emit('directionChange', true);
    self.sendCommand("ROLESREVERSED", {});
  });

  self.on('receiveCommand_ROLESREVERSED', function (params) {
    self.emit('directionChange', false);
    self.emit('serverInitialResponse');
  });

  self.on('receiveCommand_WATCH', function (params) {
    if (params.json) {
      var data = underscore.extend({class: 'WATCH',
        enable: true,
        json: true,
        nmea: false,
        raw: 0,
        scaled: false,
        timing: false }, params);
      self.sendResponse(data);
    }
    else if (params.nmea) {
      var data = underscore.extend({class: 'WATCH',
        enable: true,
        json: false,
        nmea: true,
        raw: 0,
        scaled: false,
        timing: false }, params);
      self.nmea = true;
      self.sendResponse(data);
    }
    else {
      var data = underscore.extend({class: 'WATCH', enable: false }, params);
      self.sendResponse(data);
      console.log("UNSUPPORTED WATCH");
    }
  });

  self.on('receiveComnmand_REPLAY', function (params) {
    self.sendResponse({class: 'REPLAY',
                       from: params.from});
  });

  self.on("serverInitialResponse", function () {
    self.sendResponse({class: 'VERSION',
                       release: '3.4',
                       rev: '3.4',
                       proto_major: 3,
                       proto_minor: 6,
                       capabilities: ["replay", "reverseroles"]});
  });

  self.sendNmeaResponse = function(nmea) {
    if (self.closed) return;
    var checksum = 0;

    for(var char_pos = 0; char_pos < nmea.length; char_pos++) {
      checksum = checksum ^ nmea.charCodeAt(char_pos);
    }

    var hexsum = Number(checksum).toString(16).toUpperCase();
    hexsum = ("00" + hexsum).slice(-2);

    nmea = '$' + nmea + '*' + hexsum;

    if (argv.options.verbose && underscore.include(argv.options.verbose, 'data')) {
      console.log(nmea);
    }

    self.stream.write(nmea, function (err) {
      if (err) {
        console.error(err);
        self.stream.emit("end");
      }
    });
  }
  self.responseConvertNmea = function (response) {
    if (response.class == 'SKY') {
      var nmea = [ 'GPGSA', 'A', 3 ];

      var sat_count = 0;
      for(var sat_pos in response.satellites)
      {
        if (response.satellites[sat_pos].used)
        {
          nmea[3 + sat_count] = response.satellites[sat_pos].PRN;
          sat_count++;
        }
        if (sat_count >= 12) {
          break;
        }
      }

      nmea[15] = response.pdop;
      nmea[16] = response.hdop;
      nmea[17] = response.vdop;

      self.sendNmeaResponse(nmea.join(','));
    }
    else if (response.class == 'TPV') {
      if(response.mode == 2 || response.mode == 3)
      {
        var timestamp = response.time.substr(11, 8).replace(/:/g, '');
        var date = response.time.substr(8, 2) + response.time.substr(5, 2) + response.time.substr(2, 2);

        var lat_sign = Math.sign(response.lat);
        var lat_degrees = Math.floor(response.lat * lat_sign);
        var lat_min = (response.lat - lat_degrees) * 60;
        var lat = lat_degrees * 100 + lat_min;
        lat_sign = (lat_sign < 0) ? 'E' : 'W';

        var lon_sign = Math.sign(response.lon);
        var lon_degrees = Math.floor(response.lon * lon_sign);
        var lon_min = (response.lon - lon_degrees) * 60;
        var lon = lon_degrees * 100 + lon_min;
        lon_sign = (lon_sign < 0) ? 'S' : 'N';

        var nmea = [
          'GPRMC',
          timestamp,
          'A',
          lat,
          lat_sign,
          lon,
          lon_sign,
          response.speed,
          response.track,
          date,
          0, //response.epd;
          'E'];

        self.sendNmeaResponse(nmea.join(','));
      }
    }
  };

  if (!self.isClient) {
    setTimeout(function () { self.emit("serverInitialResponse"); }, 0);
  }
}
util.inherits(exports.WireProtocol, events.EventEmitter);
