import Vue from 'vue/dist/vue.common.js'
import VueCompositionApi, { watch, defineComponent, ref } from '@vue/composition-api'
import useSWRV, { mutate } from '../src/use-swrv'
import tick from './utils/tick'
import timeout from './utils/jest-timeout'
import { advanceBy, advanceTo, clear } from 'jest-date-mock'

Vue.use(VueCompositionApi)

jest.useFakeTimers()

describe('useSWRV', () => {
  it('should return data on hydration when fetch is not a promise', async done => {
    const fetch = () => 'SWR'
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV('cache-key-not-a-promise', fetch)
      }
    }).$mount()

    expect(vm.data).toBe('SWR')
    done()
  })

  it('should return `undefined` on hydration', done => {
    const fetch = () => new Promise(res => setTimeout(() => res('SWR'), 1))
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV('cache-key-1', fetch)
      }
    }).$mount()

    expect(vm.data).toBe(undefined)
    done()
  })

  it('should return data after hydration', async done => {
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV('cache-key-2', () => 'SWR')
      }
    }).$mount()

    await tick(4)

    expect(vm.$el.textContent).toBe('hello, SWR')
    done()
  })

  it('should return data from a promise', async done => {
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV('cache-key-promise', () => new Promise(resolve => resolve('SWR')))
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('hello, ')

    await tick(2)

    expect(vm.$el.textContent).toEqual('hello, SWR')
    done()
  })

  it('should allow functions as key and reuse the cache', async done => {
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV(() => 'cache-key-2', () => 'SWR')
      }
    }).$mount()

    // immediately available via cache without waiting for $nextTick
    expect(vm.$el.textContent).toBe('hello, SWR')
    done()
  })

  it('should accept object args', async () => {
    const obj = { v: 'hello' }
    const arr = ['world']

    const vm = new Vue({
      template: `<div>{{v1}}, {{v2}}, {{v3}}</div>`,
      setup  () {
        const { data: v1 } = useSWRV(['args-1', obj, arr], (a, b, c) => {
          return a + b.v + c[0]
        })

        // reuse the cache
        const { data: v2 } = useSWRV(['args-1', obj, arr], () => 'not called!')

        // different object
        const { data: v3 } = useSWRV(['args-2', obj, 'world'], (a, b, c) => {
          return a + b.v + c
        })

        return { v1, v2, v3 }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe(`args-1helloworld, args-1helloworld, args-2helloworld`)
  })

  it('should allow async fetcher functions', async done => {
    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        return useSWRV('cache-key-3', () =>
          new Promise(res => setTimeout(() => res('SWR'), 200))
        )
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('hello, ')

    timeout(200)
    await tick(2)

    expect(vm.$el.textContent).toBe('hello, SWR')
    done()
  })

  it('should dedupe requests by default - in flight promises', async done => {
    let count = 0
    const fetch = () => {
      count++
      return new Promise(res => setTimeout(() => res('SWR'), 200))
    }

    const vm = new Vue({
      template: `<div>{{v1}}, {{v2}}, {{ validating1 ? 'yes' : 'no' }} {{ validating2 ? 'yes' : 'no' }}</div>`,
      setup  () {
        const { data: v1, isValidating: validating1 } = useSWRV('cache-key-4', fetch)
        const { data: v2, isValidating: validating2 } = useSWRV('cache-key-4', fetch)
        return { v1, v2, validating1, validating2 }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe(', , yes yes')

    timeout(200)
    await tick(2)
    expect(vm.$el.textContent).toBe('SWR, SWR, no no')

    // only fetches once
    expect(count).toEqual(1)
    done()
  })

  it('should dedupe requests by default outside of in flight promises', async done => {
    let count = 0
    const fetch = () => {
      count++
      return new Promise(res => setTimeout(() => res('SWR'), 200))
    }

    const vm = new Vue({
      template: `<div>{{v1}}, {{v2}}, {{ validating1 ? 'yes' : 'no' }} {{ validating2 ? 'yes' : 'no' }}</div>`,
      setup  () {
        const { data: v1, isValidating: validating1 } = useSWRV('cache-key-4a', fetch)
        const { data: v2, isValidating: validating2 } = useSWRV('cache-key-4a', fetch, {
          refreshInterval: 300
        })
        return { v1, v2, validating1, validating2 }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe(', , yes yes')

    timeout(200)
    await tick(2)
    expect(vm.$el.textContent).toBe('SWR, SWR, no no')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('SWR, SWR, no no')

    timeout(100)
    await tick(4)
    expect(vm.$el.textContent).toBe('SWR, SWR, no no')

    expect(count).toEqual(1)
    done()
  })

  it('should fetch dependently', async done => {
    let count = 0
    const loadUser = (): Promise<{ id: number }> => {
      return new Promise(res => setTimeout(() => {
        count++
        res({ id: 123 })
      }, 1000))
    }

    const loadProfile = () => {
      return new Promise((res) => setTimeout(() => {
        count++
        res({
          userId: 123,
          age: 20
        })
      }, 200))
    }

    const vm = new Vue({
      template: `<div>d1:{{ data1 && data1.id }} d2:{{ data2 && data2.userId }}</div>`,
      setup  () {
        const { data: data1, error: error1 } = useSWRV('/api/user', loadUser)
        // TODO: checking truthiness of data1.value to avoid watcher warning
        // https://github.com/vuejs/composition-api/issues/242
        const { data: data2, error: error2 } = useSWRV(() => data1.value && `/api/profile?id=` + data1.value.id, loadProfile)
        return { data1, error1, data2, error2 }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('d1: d2:')
    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('d1: d2:')
    expect(count).toEqual(0) // Promise still in flight

    timeout(900)
    await tick(2)
    expect(vm.$el.textContent).toBe('d1:123 d2:')
    expect(count).toEqual(1) // now that the first promise resolved, second one will fire

    timeout(200)
    await tick(2)
    expect(vm.$el.textContent).toBe('d1:123 d2:123')
    expect(count).toEqual(2)
    done()
  })

  it('should not fetch if key is falsy', async done => {
    let count = 0
    const fetch = key => {
      count++
      return new Promise(res => setTimeout(() => res(key), 100))
    }
    const vm = new Vue({
      template: `<div>{{ d1 }},{{ d2 }},{{ d3 }}</div>`,
      setup  () {
        const { data: d1 } = useSWRV('d1', fetch)
        const { data: d2 } = useSWRV(() => d1.value && 'd2', fetch)
        const { data: d3 } = useSWRV(() => d2.value && 'd3', fetch)

        return { d1, d2, d3 }
      }
    }).$mount()

    expect(count).toBe(1)
    expect(vm.$el.textContent).toBe(',,')

    timeout(100)
    await tick(2)
    expect(count).toBe(2)
    expect(vm.$el.textContent).toBe('d1,,')

    timeout(100)
    await tick(2)
    expect(count).toBe(3)
    expect(vm.$el.textContent).toBe('d1,d2,')

    timeout(100)
    await tick(3)
    expect(vm.$el.textContent).toBe('d1,d2,d3')
    done()
  })

  it('should not revalidate if key is falsy', async done => {
    let count = 0
    const fetch = key => {
      count++
      return new Promise(res => setTimeout(() => res(key), 100))
    }
    const vm = new Vue({
      template: `<div>{{ e1 }}</div>`,
      setup  () {
        const someDep = ref(undefined)
        const { data: e1 } = useSWRV(() => someDep.value, fetch, {
          refreshInterval: 1000
        })

        return { e1 }
      }
    }).$mount()

    // Does not fetch on mount
    expect(count).toBe(0)
    expect(vm.$el.textContent).toBe('')
    timeout(100)
    await tick(2)
    expect(count).toBe(0)
    expect(vm.$el.textContent).toBe('')

    // Does not revalidate even after some time passes
    timeout(100)
    await tick(2)
    expect(count).toBe(0)
    expect(vm.$el.textContent).toBe('')

    // does not revalidate on refresh interval
    timeout(1000)
    await tick(2)
    expect(count).toBe(0)
    expect(vm.$el.textContent).toBe('')

    // does not revalidate on tab changes
    let evt = new Event('visibilitychange')
    document.dispatchEvent(evt)
    timeout(100)
    await tick(2)
    expect(count).toBe(0)
    expect(vm.$el.textContent).toBe('')

    done()
  })

  // From #24
  it('should only update refs of current cache key', async done => {
    const fetcher = (key) => new Promise(res => setTimeout(() => res(key), 1000))

    const vm = new Vue({
      template: `<div>Page: {{ data }}</div>`,
      setup  () {
        const page = ref('1')
        const { data, error } = useSWRV(() => {
          return page.value
        }, fetcher)

        let interval = setInterval(() => {
          const nextPage: number = parseInt(page.value) + 1
          page.value = String(nextPage)
          nextPage > 2 && clearInterval(interval)
        }, 500)

        return { data, error, page }
      }
    }).$mount()

    // initially page is empty, but fetcher has fired with page=1
    expect(vm.$el.textContent).toBe('Page: ')
    await tick(2)
    expect(vm.$data.page).toBe('1')
    expect(vm.$el.textContent).toBe('Page: ')

    // page has now updated to page=2, fetcher1 has not yet resolved, fetcher
    // for page=2 has now fired
    timeout(500)
    await tick(2)
    expect(vm.$data.page).toBe('2')
    expect(vm.$el.textContent).toBe('Page: ')

    // fetcher for page=1 has resolved, but the cache key is not equal to the
    // current page, so the data ref does not update. fetcher for page=3 has
    // now fired
    timeout(500)
    await tick(2)
    expect(vm.$data.page).toBe('3')
    expect(vm.$el.textContent).toBe('Page: ')

    // cache key is no longer updating and the fetcher for page=3 has resolved
    // so the data ref now updates.
    timeout(1000)
    await tick(2)
    expect(vm.$data.page).toBe('3')
    expect(vm.$el.textContent).toBe('Page: 3')

    done()
  })

  it('should return cache when no fetcher provided', async done => {
    let invoked = 0
    const vm = new Vue({
      template: `<div>d:{{ data }} cache:{{ dataFromCache }}</div>`,
      setup  () {
        const fetcher = () => {
          invoked += 1
          return new Promise(res => setTimeout(() => res('SWR'), 200))
        }
        const { data } = useSWRV('cache-key-5', fetcher)
        const { data: dataFromCache } = useSWRV('cache-key-5')

        return { data, dataFromCache }
      }
    }).$mount()

    expect(invoked).toBe(1)

    expect(vm.$el.textContent).toBe('d: cache:')
    expect(invoked).toBe(1)
    timeout(200)
    await tick(2)

    expect(vm.$el.textContent).toBe('d:SWR cache:SWR')
    expect(invoked).toBe(1) // empty fetcher is OK
    done()
  })

  it('should return cache when no fetcher provided, across components', async done => {
    let invoked = 0

    const Hello = (cacheKey: string) => {
      return defineComponent({
        template: '<div>hello {{fromCache}}</div>',
        setup () {
          const { data: fromCache } = useSWRV(cacheKey)
          return { fromCache }
        }
      })
    }

    const vm = new Vue({
      template: `<div>data:{{ data }} <Hello v-if="data" /></div>`,
      components: { Hello: Hello('cache-key-6') },
      setup  () {
        const fetcher = () => {
          invoked += 1
          return new Promise(res => setTimeout(() => res('SWR'), 200))
        }
        const { data } = useSWRV('cache-key-6', fetcher)

        return { data }
      }
    }).$mount()

    expect(invoked).toBe(1)

    expect(vm.$el.textContent).toBe('data: ')
    expect(invoked).toBe(1)
    timeout(200)
    await tick(2)

    timeout(200)
    expect(vm.$el.textContent).toBe('data:SWR hello SWR')
    expect(invoked).toBe(1) // empty fetcher is OK
    done()
  })

  it('should return data even when cache ttl expires during request', async done => {
    const loadData = () => new Promise(res => setTimeout(() => res('data'), 100))
    let mutate
    const vm = new Vue({
      render: h => h(defineComponent({
        template: `<div>hello, {{data}}, {{isValidating ? 'loading' : 'ready'}}</div>`,
        setup () {
          const { data, isValidating, mutate: revalidate } = useSWRV('is-validating-3', loadData, {
            ttl: 50,
            dedupingInterval: 0
          })

          mutate = revalidate
          return {
            data,
            isValidating
          }
        }
      }))
    }).$mount()

    timeout(75)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, , loading')

    timeout(25)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, ready')

    mutate()
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, loading')
    timeout(25)
    mutate()
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, loading')

    mutate()
    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, ready')
    done()
  })

  // from #54
  it('does not invalidate cache when ttl is 0', async done => {
    advanceTo(new Date())
    const ttl = 0
    let count = 0
    const fetch = () => {
      count++
      return Promise.resolve(count)
    }

    mutate('ttlData1', fetch(), undefined, ttl)

    const vm1 = new Vue({
      template: `<div>{{ data1 }}</div>`,
      setup  () {
        const { data: data1 } = useSWRV('ttlData1', undefined, { ttl, fetcher: undefined })

        return { data1 }
      }
    }).$mount()
    const component = {
      template: `<div>{{ data2 }}</div>`,
      setup  () {
        const { data: data2 } = useSWRV('ttlData1', undefined, { ttl, fetcher: undefined })

        return { data2 }
      }
    }

    let vm2
    await tick(2)

    // first time
    expect(count).toBe(1)
    expect(vm1.$el.textContent).toBe('1')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('1')

    // after #51 gracePeriod
    advanceBy(6000)
    timeout(6000)
    mutate('ttlData1', fetch(), undefined, ttl)
    await tick(2)

    expect(count).toBe(2)
    expect(vm1.$el.textContent).toBe('2')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('2')

    // after a long time
    advanceBy(100000)
    timeout(100000)
    await tick(2)

    expect(count).toBe(2)
    expect(vm1.$el.textContent).toBe('2')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('2')

    clear()

    done()
  })

  // from #54
  it('does invalidate cache when ttl is NOT 0', async done => {
    advanceTo(new Date())
    const ttl = 100
    let count = 0
    const fetch = () => {
      count++
      return Promise.resolve(count)
    }

    mutate('ttlData2', fetch(), undefined, ttl)

    const vm1 = new Vue({
      template: `<div>{{ data1 }}</div>`,
      setup  () {
        const { data: data1 } = useSWRV('ttlData2', undefined, { ttl, fetcher: undefined })

        return { data1 }
      }
    }).$mount()
    const component = {
      template: `<div>{{ data2 }}</div>`,
      setup  () {
        const { data: data2 } = useSWRV('ttlData2', undefined, { ttl, fetcher: undefined })

        return { data2 }
      }
    }

    let vm2
    await tick(2)

    // first time
    expect(count).toBe(1)
    expect(vm1.$el.textContent).toBe('1')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('1')

    // after #51 gracePeriod
    advanceBy(6000)
    timeout(6000)
    mutate('ttlData2', fetch(), undefined, ttl)
    await tick(2)

    expect(count).toBe(2)
    expect(vm1.$el.textContent).toBe('1')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('2')

    // after a long time
    advanceBy(100000)
    timeout(100000)
    await tick(2)

    expect(count).toBe(2)
    expect(vm1.$el.textContent).toBe('1')
    vm2 = new Vue(component).$mount()
    expect(vm2.$el.textContent).toBe('')

    clear()

    done()
  })

  it('should use fetch api as default fetcher', async () => {
    const users = [{ name: 'bob' }, { name: 'sue' }]
    global['fetch'] = () => Promise.resolve()
    const mockFetch = body => Promise.resolve({ json: () => Promise.resolve(body) } as any)
    jest.spyOn(window, 'fetch').mockImplementation(() => mockFetch(users))

    const vm = new Vue({
      template: `<div v-if="data">hello, {{ data.map(u => u.name).join(' and ') }}</div>`,
      setup  () {
        return useSWRV('http://localhost:3000/api/users')
      }
    }).$mount()

    await tick(4)

    expect(vm.$el.textContent).toBe('hello, bob and sue')
    delete global['fetch']
  })
})

describe('useSWRV - loading', () => {
  const loadData = () => new Promise(res => setTimeout(() => res('data'), 100))

  it('should return loading state via undefined data', async done => {
    let renderCount = 0
    const vm = new Vue(defineComponent({
      render (h) {
        renderCount++
        return h('div', `hello, ${!this.data ? 'loading' : this.data}`)
      },
      setup () {
        return useSWRV('is-validating-1', loadData)
      }
    })).$mount()

    expect(renderCount).toEqual(1)
    expect(vm.$el.textContent).toBe('hello, loading')
    timeout(100)

    await tick(2)

    expect(vm.$el.textContent).toBe('hello, data')
    expect(renderCount).toEqual(2)
    done()
  })

  it('should return loading state via isValidating', async done => {
    const vm = new Vue(defineComponent({
      template: `<div>hello, {{this.data}}, {{this.isValidating ? 'loading' : 'ready'}}</div>`,
      setup () {
        return useSWRV('is-validating-2', loadData, {
          refreshInterval: 1000,
          dedupingInterval: 0
        })
      }
    })).$mount()

    expect(vm.$el.textContent).toBe('hello, , loading')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, ready')

    // Reactive to future refreshes
    timeout(900)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, data, loading')

    done()
  })

  // #195
  it('should return loading state isValidating with nullish key', async done => {
    const vm = new Vue(defineComponent({
      template: `<div>{{ error }}:{{this.isValidating ? 'loading' : 'ready'}}</div>`,
      setup () {
        return useSWRV(() => null)
      }
    })).$mount()

    expect(vm.$el.textContent).toBe(':ready')
    done()
  })
})

describe('useSWRV - mutate', () => {
  it('prefetches via mutate', done => {
    // Prime the cache
    const loadData = key => new Promise(res => setTimeout(() => res(key), 100))
    mutate('is-prefetched-1', loadData('is-prefetched-1')).then(() => {
      const vm = new Vue({
        render: h => h(defineComponent({
          render (h) {
            return h('div', `hello, ${this.msg1} and ${this.msg2}`)
          },
          setup () {
            const { data: dataFromCache } = useSWRV('is-prefetched-1', loadData)
            const { data: dataNotFromCache } = useSWRV('is-prefetched-2', loadData)

            const msg1 = !dataFromCache.value ? 'loading' : dataFromCache.value
            const msg2 = !dataNotFromCache.value ? 'loading' : dataNotFromCache.value

            return { msg1, msg2 }
          }
        }))
      }).$mount()

      expect(vm.$el.textContent).toBe('hello, is-prefetched-1 and loading')
      done()
    })

    timeout(100)
  })

  it('mutate triggers revalidations', async done => {
    let count = 0
    const loadData = () => new Promise(res => {
      setTimeout(() => {
        res(++count)
      }, 100)
    })
    const vm = new Vue(defineComponent({
      template: `<div>hello, {{data}}</div>`,
      setup () {
        const { data, mutate } = useSWRV('mutate-no-arg', loadData)

        setTimeout(() => {
          // immune to deduping interval
          mutate()
        }, 200)

        return {
          data
        }
      }
    })).$mount()

    expect(vm.$el.textContent).toBe('hello, ')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('hello, 1')

    timeout(200)
    await tick(4)
    expect(vm.$el.textContent).toBe('hello, 2')

    done()
  })
})

describe('useSWRV - listeners', () => {
  it('tears down listeners', async done => {
    const f1 = jest.fn()
    const f2 = jest.fn()
    const f3 = jest.fn()
    const f4 = jest.fn()

    jest.spyOn(document, 'addEventListener').mockImplementationOnce(f1)
    jest.spyOn(document, 'removeEventListener').mockImplementationOnce(f2)
    jest.spyOn(window, 'addEventListener').mockImplementationOnce(f3)
    jest.spyOn(window, 'removeEventListener').mockImplementationOnce(f4)

    const vm = new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        const refs = useSWRV('cache-key-listeners-1', () => 'SWR')
        return refs
      }
    }).$mount()

    await vm.$nextTick()

    vm.$destroy()

    expect(f1).toHaveBeenLastCalledWith('visibilitychange', expect.any(Function), false)
    expect(f2).toHaveBeenLastCalledWith('visibilitychange', expect.any(Function), false)
    expect(f3).toHaveBeenLastCalledWith('focus', expect.any(Function), false)
    expect(f4).toHaveBeenLastCalledWith('focus', expect.any(Function), false)

    expect(f1).toHaveBeenCalledTimes(1)
    expect(f2).toHaveBeenCalledTimes(1)
    expect(f3).toHaveBeenCalledTimes(1)
    expect(f4).toHaveBeenCalledTimes(1)
    done()
  })

  it('events trigger revalidate - switching windows/tabs', async () => {
    let revalidations = 0
    new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        const refs = useSWRV('cache-key-listeners-2', () => {
          revalidations += 1
          return 'SWR'
        }, { dedupingInterval: 0 })
        return refs
      }
    }).$mount()

    await tick(2)
    expect(revalidations).toBe(1)

    let evt = new Event('visibilitychange')
    document.dispatchEvent(evt)

    await tick(2)
    expect(revalidations).toBe(2)
  })

  it('events trigger revalidate - focusing back on a window/tab', async () => {
    let revalidations = 0
    new Vue({
      template: `<div>hello, {{ data }}</div>`,
      setup  () {
        const refs = useSWRV('cache-key-listeners-3', () => {
          revalidations += 1
          return 'SWR'
        }, { dedupingInterval: 0 })
        return refs
      }
    }).$mount()

    await tick(2)
    expect(revalidations).toBe(1)

    let evt = new Event('focus')
    window.dispatchEvent(evt)

    await tick(2)
    expect(revalidations).toBe(2)
  })
})

describe('useSWRV - refresh', () => {
  it('should rerender automatically on interval', async done => {
    let count = 0
    const vm = new Vue({
      template: `<div>count: {{ data }}</div>`,
      setup  () {
        return useSWRV('dynamic-1', () => count++, {
          refreshInterval: 200,
          dedupingInterval: 0
        })
      }
    }).$mount()

    await tick(2)
    expect(vm.$el.textContent).toEqual('count: 0')
    timeout(210)
    await tick(2)
    expect(vm.$el.textContent).toEqual('count: 1')
    timeout(50)
    await tick(2)
    expect(vm.$el.textContent).toEqual('count: 1')
    timeout(150)
    await tick(2)
    expect(vm.$el.textContent).toEqual('count: 2')
    done()
  })

  it('should dedupe requests combined with intervals - promises', async done => {
    advanceTo(new Date())
    /**
     * TODO: right now, only promises get deduped, so if the fetcherFn is a
     * regular function then it will keep refreshing.
     */
    let count = 0
    const loadData = () => new Promise(res => setTimeout(() => {
      res(++count)
    }, 100)) // Resolves quickly, but gets de-duplicated during refresh intervals

    const vm = new Vue({
      template: `<div>count: {{ data }}</div>`,
      setup  () {
        return useSWRV('dynamic-2', loadData, {
          refreshInterval: 200,
          dedupingInterval: 300
        })
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('count: ')
    advanceBy(100)
    timeout(100)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: 1') // first resolve
    /**
     * check inside promises cache within deduping interval so even though
     * promise resolves quickly, it will grab the promise out of the cache
     * instead and not increment the count
     */
    advanceBy(100)
    timeout(100) // first fetcher fire
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')

    advanceBy(100)
    timeout(100) // deduped
    await tick(2)
    expect(vm.$el.textContent).toBe('count: 1')

    advanceBy(100)
    timeout(100) // second fetcher fire
    await tick(2)
    expect(vm.$el.textContent).toBe('count: 1')

    advanceBy(200)
    timeout(200)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: 2')

    clear()
    done()
  })

  it('should refresh on interval using dependent watchers', async done => {
    type User = { id: string }
    let count = -1
    const vm = new Vue({
      template: `<div v-if="user">User-{{user.id}} votes: {{ votes }}</div>`,
      setup  () {
        const { data: user } = useSWRV<User>('/users', () => {
          return new Promise((res) => {
            setTimeout(() => res({ id: '1' }), 200)
          })
        })
        const { data: votes } = useSWRV(() => user.value && `/users/${user.value.id}/votes`, () => {
          return ++count
        }, {
          refreshInterval: 200,
          dedupingInterval: 0
        })

        return {
          user,
          votes
        }
      }
    }).$mount()

    await tick(2)
    expect(vm.$el.textContent).toEqual('')
    timeout(210)
    await tick(2)
    expect(vm.$el.textContent).toEqual('User-1 votes: 0')
    timeout(50)
    await tick(2)
    expect(vm.$el.textContent).toEqual('User-1 votes: 0')
    timeout(150)
    await tick(2)
    expect(vm.$el.textContent).toEqual('User-1 votes: 1')
    timeout(200)
    await tick(2)
    expect(vm.$el.textContent).toEqual('User-1 votes: 2')
    done()
  })
})

describe('useSWRV - error', () => {
  it('should handle errors', async done => {
    const vm = new Vue({
      template: `<div>
        <div v-if="data">hello, {{ data }}</div>
        <div v-if="error">{{error.message}}</div>
      </div>`,
      setup  () {
        return useSWRV(() => 'error-1', () => new Promise((_, reject) => {
          reject(new Error('error!'))
        }))
      }
    }).$mount()

    await tick(2)

    expect(vm.$el.textContent.trim()).toBe('error!')
    done()
  })

  it('should be able to watch errors - similar to onError callback', async done => {
    let erroredSWR = null

    const vm = new Vue({
      template: `<div>
        <div>hello, {{ data }}</div>
      </div>`,
      setup  () {
        const { data, error } = useSWRV(() => 'error-2', () => new Promise((_, rej) =>
          setTimeout(() => rej(new Error('error!')), 200)
        ))

        watch(error, error1 => {
          erroredSWR = error1 && error1.message
        })

        return {
          data, error
        }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('hello, ')
    timeout(200)
    await tick(2)
    expect(erroredSWR).toEqual('error!')
    done()
  })

  it('should serve stale-if-error', async done => {
    let count = 0
    const loadData = () => new Promise((resolve, reject) => setTimeout(() => {
      count++
      count > 2 ? reject(new Error('uh oh!')) : resolve(count)
    }, 100))

    const vm = new Vue({
      template: `<div>count: {{ data }} {{ error }}</div>`,
      setup  () {
        return useSWRV('error-3', loadData, {
          refreshInterval: 200,
          dedupingInterval: 0
        })
      }
    }).$mount()

    timeout(300) // 200 refresh + 100 timeout
    await tick(3)
    expect(vm.$el.textContent).toBe('count: 1 ')

    timeout(300)
    await tick(3)
    expect(vm.$el.textContent).toBe('count: 2 ')

    timeout(300)
    await tick(2)
    // stale data sticks around even when error exists
    expect(vm.$el.textContent).toBe('count: 2 Error: uh oh!')
    done()
  })

  it('should reset error if fetching succeeds', async done => {
    let count = 0
    let revalidate

    const vm = new Vue({
      template: `<div>count: {{ data }} {{ error }}</div>`,
      setup () {
        const { data, error, mutate } = useSWRV(
          'error-4',
          () => new Promise(
            (resolve, reject) => setTimeout(() => ++count === 2 ? reject(new Error('uh oh!')) : resolve(count), 100)
          ),
          { dedupingInterval: 0 }
        )
        revalidate = mutate
        return { data, error }
      }
    }).$mount()

    timeout(100)
    await tick(3)
    expect(vm.$el.textContent).toBe('count: 1 ')

    revalidate()
    timeout(100)
    await tick(3)
    // stale data sticks around even when error exists
    expect(vm.$el.textContent).toBe('count: 1 Error: uh oh!')

    revalidate()
    timeout(100)
    await tick(3)
    // error must be reset if fetching succeeds
    expect(vm.$el.textContent).toBe('count: 3 ')
    done()
  })

  it('should trigger error retry', async done => {
    let count = 0

    const vm = new Vue({
      template: `<div>count: {{ data }}, {{ error }}</div>`,
      setup () {
        const { data, error } = useSWRV(
          'error-retry-1',
          () => new Promise((resolve, reject) => setTimeout(() => {
            ++count <= 2 ? reject(new Error(`${count}`)) : resolve(count)
          }, 100)),
          {
            dedupingInterval: 0,
            errorRetryInterval: 500
          }
        )
        return { data, error }
      }
    }).$mount()

    expect(vm.$el.textContent.trim()).toBe('count: ,')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: , Error: 1')

    timeout(600)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: , Error: 2')

    timeout(900)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: , Error: 2')

    timeout(200)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: 3,')
    done()
  })

  it('should trigger error retry and stop at count max', async done => {
    let count = 0

    const vm = new Vue({
      template: `<div>count: {{ data }}, {{ error }}</div>`,
      setup () {
        const { data, error } = useSWRV(
          'error-retry-2',
          () => new Promise((resolve, reject) => setTimeout(() => {
            ++count <= 6 ? reject(new Error(`${count}`)) : resolve(count)
          }, 100)),
          {
            dedupingInterval: 0,
            errorRetryInterval: 500,
            errorRetryCount: 3
          }
        )
        return { data, error }
      }
    }).$mount()

    expect(vm.$el.textContent.trim()).toBe('count: ,')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: , Error: 1')

    timeout(600)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: , Error: 2')

    timeout(1100)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: , Error: 3')

    timeout(1600)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: , Error: 4')

    timeout(2100)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: , Error: 4') // Does not exceed retry count

    done()
  })

  it('should respect disabled error retry', async done => {
    let count = 0

    const vm = new Vue({
      template: `<div>count: {{ data }}, {{ error }}</div>`,
      setup () {
        const { data, error } = useSWRV(
          'error-retry-3',
          () => new Promise((resolve, reject) => setTimeout(() => {
            ++count <= 3 ? reject(new Error(`${count}`)) : resolve(count)
          }, 100)),
          {
            dedupingInterval: 0,
            shouldRetryOnError: false,
            errorRetryInterval: 500
          }
        )
        return { data, error }
      }
    }).$mount()

    expect(vm.$el.textContent.trim()).toBe('count: ,')

    timeout(100)
    await tick(2)
    expect(vm.$el.textContent.trim()).toBe('count: , Error: 1')

    timeout(600)
    await tick(2)
    expect(vm.$el.textContent).toBe('count: , Error: 1')

    done()
  })

  it('should display friendly error message when swrv is not top level in setup', async done => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const vm = new Vue({
      template: '<button v-on:click="dontDoThis">bad idea</button>',
      setup  () {
        function dontDoThis () {
          useSWRV(() => 'error-top-level', () => 'hello')
        }

        return {
          dontDoThis
        }
      }
    }).$mount()

    vm.$el.click()

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Could not get current instance, check to make sure that `useSwrv` is declared in the top level of the setup function.'))

    spy.mockRestore()
    done()
  })
})

describe('useSWRV - window events', () => {
  const toggleVisibility = (state: VisibilityState) => Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: function (): VisibilityState { return state }
  })

  const toggleOnline = (state: boolean) => Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: function (): boolean { return state }
  })

  afterEach(() => {
    toggleOnline(true)
    toggleVisibility('visible')
  })

  it('should not rerender when document is not visible', async () => {
    let count = 0

    const vm = new Vue({
      template: `<div>count: {{ data }}</div>`,
      setup  () {
        return useSWRV('dynamic-5', () => count++, {
          refreshInterval: 200,
          dedupingInterval: 0
        })
      }
    }).$mount()

    await tick(1)
    expect(vm.$el.textContent).toBe('count: 0')

    toggleVisibility(undefined)
    timeout(200)
    await tick(1)
    // should still update even though visibilityState is undefined
    expect(vm.$el.textContent).toBe('count: 1')

    toggleVisibility('hidden')

    timeout(200)
    await tick(1)

    // should not rerender because document is hidden e.g. switched tabs
    expect(vm.$el.textContent).toBe('count: 1')

    vm.$destroy()
  })

  it('should get last known state when document is not visible', async () => {
    let count = 0
    mutate('dynamic-5-1', count)
    toggleVisibility('hidden')

    const vm = new Vue({
      template: `<div>count: {{ data }}</div>`,
      setup () {
        return useSWRV('dynamic-5-1', () => ++count, {
          refreshInterval: 200,
          dedupingInterval: 0
        })
      }
    }).$mount()

    // first fetch always renders #128
    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')
    expect(count).toBe(1)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')
    expect(count).toBe(1)

    // subsequent fetches while document is hidden do not rerender
    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')
    expect(count).toBe(1)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')
    expect(count).toBe(1)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 1')
    expect(count).toBe(1)

    toggleVisibility('visible')

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 2')
    expect(count).toBe(2)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 2')
    expect(count).toBe(2)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 3')
    expect(count).toBe(3)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 3')
    expect(count).toBe(3)

    timeout(200)
    await tick(1)
    expect(vm.$el.textContent).toBe('count: 4')
    expect(count).toBe(4)

    vm.$destroy()
  })

  it('should not rerender when offline', async () => {
    let count = 0

    const vm = new Vue({
      template: `<div>count: {{ data }}</div>`,
      setup  () {
        return useSWRV('dynamic-6', () => count++, {
          refreshInterval: 200,
          dedupingInterval: 0
        })
      }
    }).$mount()

    await tick(1)
    expect(vm.$el.textContent).toBe('count: 0')

    toggleOnline(undefined)

    timeout(200)
    await tick(1)
    // should rerender since we're AMERICA ONLINE
    expect(vm.$el.textContent).toBe('count: 1')

    // connection drops... your mom picked up the phone while you were 🏄‍♂️ the 🕸
    toggleOnline(false)

    timeout(200)
    await tick(1)
    // should not rerender cuz offline
    expect(vm.$el.textContent).toBe('count: 1')
  })

  // https://github.com/Kong/swrv/issues/128
  it('fetches data on first render even when document is not visible', async () => {
    toggleVisibility('hidden')

    const vm = new Vue({
      template: `<div>{{ data }}</div>`,
      setup  () {
        const { data, error } = useSWRV(
          'fetches-data-even-when-document-is-not-visible',
          () => new Promise(res => setTimeout(() => res('first'), 100))
        )
        return { data, error }
      }
    }).$mount()

    expect(vm.$el.textContent).toBe('')

    timeout(100)
    await tick()

    expect(vm.$el.textContent).toBe('first')
  })
})
