/* eslint-disable @typescript-eslint/camelcase */
/*
 * Copyright 2015 Daishinsha Inc.
 *
 * This file is part of Vivliostyle UI.
 *
 * Vivliostyle UI is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle UI is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle UI.  If not, see <http://www.gnu.org/licenses/>.
 */

module.exports = function (config) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const commonConfig = require("./karma-common.conf")(config);
  const customLaunchers = {
    sl_chrome: {
      base: "SauceLabs",
      browserName: "chrome",
      platform: "Windows 10",
    },
    sl_firefox: {
      base: "SauceLabs",
      browserName: "firefox",
      platform: "Windows 10",
    },
    sl_safari: {
      base: "SauceLabs",
      browserName: "safari",
      platform: "OS X 10.11",
    },
    sl_edge: {
      base: "SauceLabs",
      browserName: "microsoftedge",
      platform: "Windows 10",
    },
  };

  const options = {
    reporters: ["verbose", "saucelabs"],
    sauceLabs: {
      build: process.env.TRAVIS_BUILD_NUMBER,
      testName: "vivliostyle-js-viewer",
      recordScreenshots: false,
      startConnect: false, // Sauce Connect is started by Travis CI
      tunnelIdentifier: process.env.TRAVIS_JOB_NUMBER,
    },
    captureTimeout: 120000,
    customLaunchers: customLaunchers,
    browsers: Object.keys(customLaunchers),
    singleRun: true,
  };
  for (const key in commonConfig) {
    if (Object.prototype.hasOwnProperty.call(commonConfig, key)) {
      options[key] = commonConfig[key];
    }
  }

  config.set(options);
};
