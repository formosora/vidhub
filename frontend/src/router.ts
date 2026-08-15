import { createRouter, createWebHistory } from 'vue-router'
import Home from './pages/Home.vue'
import Explore from './pages/Explore.vue'
import Stats from './pages/Stats.vue'
import Login from './pages/Login.vue'
import My from './pages/My.vue'
import Admin from './pages/Admin.vue'
import Terms from './pages/Terms.vue'
import NotFound from './pages/NotFound.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/explore', name: 'explore', component: Explore },
    { path: '/stats', name: 'stats', component: Stats },
    { path: '/login', name: 'login', component: Login },
    { path: '/my', name: 'my', component: My },
    { path: '/admin', name: 'admin', component: Admin },
    { path: '/terms', name: 'terms', component: Terms },
    // catch-all: an unknown path used to render the chrome with a blank body
    { path: '/:pathMatch(.*)*', name: 'notfound', component: NotFound },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
