import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { installAppLogging } from '@/lib/logging'
import '@/assets/index.css'
import 'vue-sonner/style.css'

const app = createApp(App)

await installAppLogging(app)

app.use(createPinia())
app.use(router)

app.mount('#app')
