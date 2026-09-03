// Static-host configuration for Vercel or Netlify.
window.SCHIZOEYE_API_BASE =
	window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
		? 'http://localhost:5000'
		: 'https://your-backend-app.onrender.com';