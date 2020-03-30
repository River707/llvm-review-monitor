'use strict';
const path = require('path');
const ClosurePlugin = require('closure-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const SizePlugin = require('size-plugin');

module.exports = [{
	devtool: 'sourcemap',
	stats: 'errors-only',
	entry: {
		background: './source/background',
	},
	output: {
		path: path.join(__dirname, 'build'),
		filename: '[name].js'
	},
	node: {
		fs: 'empty'
	},
	plugins: [
		new SizePlugin(),
		new CopyWebpackPlugin([
			{
				from: '**/*',
				context: 'source',
				ignore: ['*.js']
			},
			{
				from: 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js'
			}
		])
	],
	optimization: {
		minimizer: [
			new TerserPlugin({
				terserOptions: {
					mangle: false,
					compress: false,
					output: {
						beautify: true,
						indent_level: 2 // eslint-disable-line camelcase
					}
				}
			})
		]
	}
}, {
	devtool: 'source-map',
	entry: {
		popup: './source/popup'
	},
	output: {
		path: path.join(__dirname, 'build'),
		filename: '[name].js'
	},
	optimization: {
		minimizer: [
			new ClosurePlugin({
				mode: 'AGGRESSIVE_BUNDLE',
				platform: 'java',
			}, {
				// formatting: 'PRETTY_PRINT',
				// debug: true,
				// renaming: false
			})
		],
		concatenateModules: false,
	},
	plugins: [
		new ClosurePlugin.LibraryPlugin({
			closureLibraryBase: require.resolve(
				'google-closure-library/closure/goog/base'
			),
			deps: [
				require.resolve('google-closure-library/closure/goog/deps'),
				'./source/deps.js',
			],
		})
	]
}];