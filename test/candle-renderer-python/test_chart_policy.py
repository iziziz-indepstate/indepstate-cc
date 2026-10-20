"""Execute the indicator's timer against a bounded fake chart API.

Only MQL array syntax is adapted to C++ vectors. This exercises the production
timer, including its ACK and cleanup decisions; MetaEditor compilation remains
a separate required Windows check.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent.parent

HARNESS = r'''
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using string=std::string;
struct Marker {string id,revision,symbol,timeframe,tool,side;long time;double price;long lineColor;};
enum ENUM_OBJECT_PROPERTY_INTEGER {OBJPROP_TYPE,OBJPROP_COLOR,OBJPROP_WIDTH,OBJPROP_STYLE,OBJPROP_BACK,OBJPROP_TIMEFRAMES,OBJPROP_SELECTABLE,OBJPROP_SELECTED,OBJPROP_HIDDEN};
using ENUM_OBJECT=int;
const int OBJ_HLINE=8,STYLE_SOLID=0,OBJ_ALL_PERIODS=2097151,OBJPROP_PRICE=20,OBJPROP_TOOLTIP=21;
using color=long;
struct Object {double price;int window=0;std::map<int,long> properties;string tooltip;Object(double p=0):price(p){properties[OBJPROP_TYPE]=OBJ_HLINE;}};
struct Chart {long id;string symbol;std::map<string,Object> objects;};
const string PREFIX="ISCC_TV_",ACK_FILE="ack";
const int FILE_WRITE=1,FILE_TXT=2,FILE_ANSI=4,FILE_SHARE_READ=8,CP_UTF8=65001,INVALID_HANDLE=-1,SYMBOL_DIGITS=1;
std::vector<Marker> input;std::vector<Chart> charts;string ack;int opened=0,writes=0,redraws=0;bool failDraw=false,failRead=false;
template<class T> int ArraySize(const std::vector<T> &a){return a.size();}
template<class T> void ArrayResize(std::vector<T> &a,int n){a.resize(n);}
template<class T> void ArrayInitialize(std::vector<T> &a,bool value){std::fill(a.begin(),a.end(),value);}
void check(bool yes,const char* why){if(!yes)throw std::runtime_error(why);}
Chart& get(long id){for(auto& c:charts)if(c.id==id)return c;throw std::runtime_error("Unknown chart");}
long ChartFirst(){return charts.empty()?-1:charts.front().id;}
long ChartNext(long id){for(size_t i=0;i<charts.size();i++)if(charts[i].id==id)return i+1<charts.size()?charts[i+1].id:-1;return -1;}
string ChartSymbol(long id){return get(id).symbol;}
void ChartRedraw(long){++redraws;}
const int PERIOD_M5=5;
long ChartOpen(string symbol,int){++opened;charts.push_back({100+opened,symbol,{}});return charts.back().id;}
int ObjectsTotal(long id){return get(id).objects.size();}
string ObjectName(long id,int n){auto p=get(id).objects.begin();std::advance(p,n);return p->first;}
int ObjectFind(long id,string name){return get(id).objects.count(name)?get(id).objects.at(name).window:-1;}
bool ObjectDelete(long id,string name){++writes;return get(id).objects.erase(name)>0;}
bool ObjectCreate(long id,string name,int type,int window,long,double price){if(failDraw)return false;++writes;auto& o=get(id).objects[name];o.price=price;o.window=window;o.properties[OBJPROP_TYPE]=type;return true;}
bool ObjectGetInteger(long id,string name,ENUM_OBJECT_PROPERTY_INTEGER property,int,long& actual){if(failRead || !get(id).objects.count(name))return false;actual=get(id).objects.at(name).properties[property];return true;}
long ObjectGetInteger(long id,string name,ENUM_OBJECT_PROPERTY_INTEGER property){long actual=0;ObjectGetInteger(id,name,property,0,actual);return actual;}
bool ObjectGetDouble(long id,string name,int,int,double& actual){if(failRead || !get(id).objects.count(name))return false;actual=get(id).objects.at(name).price;return true;}
double ObjectGetDouble(long id,string name,int property,int modifier){double actual=0;ObjectGetDouble(id,name,property,modifier,actual);return actual;}
bool ObjectGetString(long id,string name,int,int,string& actual){if(failRead || !get(id).objects.count(name))return false;actual=get(id).objects.at(name).tooltip;return true;}
bool ObjectSetInteger(long id,string name,ENUM_OBJECT_PROPERTY_INTEGER property,long expected){++writes;if(failDraw)return false;get(id).objects.at(name).properties[property]=expected;return true;}
bool ObjectSetDouble(long id,string name,int,int,double expected){++writes;if(failDraw)return false;get(id).objects.at(name).price=expected;return true;}
bool ObjectSetString(long id,string name,int,string expected){++writes;if(failDraw)return false;get(id).objects.at(name).tooltip=expected;return true;}
double MathAbs(double value){return std::abs(value);}
string TimeToString(long value){return std::to_string(value);}
int StringFind(string a,string b){auto n=a.find(b);return n==string::npos?-1:n;}
string IntegerToString(long value){return std::to_string(value);}
string DoubleToString(double value,int digits){std::ostringstream out;out<<std::fixed<<std::setprecision(digits)<<value;return out.str();}
long SymbolInfoInteger(string,int){return 2;}
long ToRgb(long rgb){return rgb;}
bool Load(std::vector<Marker>& markers,string& generation,int& protocol){markers=input;generation=string(64,'a');protocol=2;return true;}
int FileOpen(string,int,int,int){ack.clear();return 1;}
void FileWriteString(int,string text){ack+=text;}
void FileClose(int){}
@@PRODUCTION@@
Marker marker(char id,string symbol="USTEC"){return {string(24,id),"1",symbol,"M5","ray","high",1234,29547.45,16711680};}
int count(string text,string token){int n=0;size_t p=0;while((p=text.find(token,p))!=string::npos){++n;p+=token.size();}return n;}
int main(int argc,char**argv){try{
 string scenario=argv[1];
 if(scenario=="missing"){
  charts={{1,"SPX500",{{"manual",77}}}};input={marker('a'),marker('b'),marker('c')};
  for(int i=0;i<20;i++)OnTimer();
  check(opened==0 && charts.size()==1,"A missing symbol must not open charts, including repeated markers/timers");
  check(count(ack,"\tpending\t")==3,"Missing chart must remain pending");
  check(get(1).objects.count("manual"),"Manual object was removed");
 }else if(scenario=="existing"){
  charts={{1,"USTEC",{{"manual",77}}},{2,"USTEC",{}},{3,"SPX500",{}}};
  input={marker('a'),marker('b'),marker('c'),marker('d',"SPX500")};
  for(int i=0;i<20;i++)OnTimer();
  check(opened==0 && charts.size()==3,"Existing charts were duplicated");
  check(get(1).objects.size()==4 && get(2).objects.size()==3 && get(3).objects.size()==1,"Levels must draw on all matching existing charts");
  check(count(ack,"\tready\t")==4,"Matching charts must be acknowledged");
 }else if(scenario=="reopen"){
  charts={{1,"USTEC",{}}};input={marker('a')};OnTimer();charts.clear();
  for(int i=0;i<3;i++)OnTimer();
  check(charts.empty() && count(ack,"\tpending\t")==1,"Closing a chart must not reopen it");
  charts.push_back({9,"USTEC",{{"manual",77}}});OnTimer();
  check(opened==0 && get(9).objects.size()==2 && count(ack,"\tready\t")==1,"Manually reopened chart must receive the level");
 }else if(scenario=="delete"){
  charts={{1,"USTEC",{{"manual",77},{PREFIX+string(24,'a'),99}}}};
  OnTimer();check(charts.size()==1 && get(1).objects.size()==1 && get(1).objects.count("manual"),"Cleanup must remove only owned stale objects");
 }else if(scenario=="failed-draw"){
  charts={{1,"USTEC",{}}};input={marker('a')};failDraw=true;OnTimer();
  check(count(ack,"\tpending\t")==1 && opened==0,"Failed drawing must not acknowledge or open a replacement chart");
 }else if(scenario=="steady"){
  charts={{1,"USTEC",{}},{2,"SPX500",{}}};input={marker('a'),marker('b'),marker('c',"SPX500")};OnTimer();
  writes=redraws=0;for(int i=0;i<20;i++)OnTimer();
  check(writes==0 && redraws==0,"Unchanged levels must not rewrite objects or force chart redraws");
  check(count(ack,"\tready\t")==3,"Unchanged levels must still be verified and acknowledged");
 }else if(scenario=="batch"){
  charts={{1,"USTEC",{}},{2,"USTEC",{}},{3,"SPX500",{}}};
  for(int i=0;i<20;i++)input.push_back(marker('a'+i));OnTimer();
  check(redraws==2,"A whole marker batch must redraw each changed chart only once");
  writes=redraws=0;input[0].price+=1;input[0].lineColor=123;OnTimer();
  check(writes==4 && redraws==2,"Only changed price/color on matching charts should be written");
 }else if(scenario=="repair"){
  charts={{1,"USTEC",{{"manual",77}}}};input={marker('a')};OnTimer();
  auto name=PREFIX+input[0].id;get(1).objects.erase(name);OnTimer();
  check(get(1).objects.count(name) && get(1).objects.count("manual"),"Deleted owned level must be restored without touching manual objects");
  get(1).objects.at(name).window=1;OnTimer();
  check(get(1).objects.at(name).window==0,"Owned object in an indicator subwindow must be repaired");
  get(1).objects.at(name).properties[OBJPROP_COLOR]=321;OnTimer();
  check(get(1).objects.at(name).properties[OBJPROP_COLOR]==input[0].lineColor,"Actual color drift must be repaired");
 }else if(scenario=="read-error"){
  charts={{1,"USTEC",{}}};input={marker('a')};OnTimer();failRead=true;writes=redraws=0;OnTimer();
  check(count(ack,"\tpending\t")==1 && writes==0 && redraws==0,"A read error must not reuse a cached ready ACK");
  failRead=false;OnTimer();check(count(ack,"\tready\t")==1,"Reading recovery must resume confirmation");
 }else throw std::runtime_error("Unknown scenario");
 std::cout<<scenario<<" PASS\n";return 0;
 }catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}}
'''


@unittest.skipUnless(shutil.which('c++'), 'C++ compiler unavailable for the MQL timer harness')
class ChartPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        source = Path(os.environ.get('CANDLE_INDICATOR_SOURCE', ROOT/'extensions/candleLevelRenderer/mt5/ISCC Candle Levels.mq5')).read_text()
        drawing = source[source.index('bool Contains('):source.index('int OnInit()')]
        timer = source[source.index('void OnTimer()'):]
        production = (drawing + timer).replace('Marker &markers[]', 'std::vector<Marker> &markers')
        production = production.replace('Marker markers[];', 'std::vector<Marker> markers;')
        production = production.replace('long charts[];string symbols[];bool changed[];', 'std::vector<long> charts;std::vector<string> symbols;std::vector<bool> changed;')
        production = production.replace('bool found[],ready[];', 'std::vector<bool> found,ready;')
        file = Path(cls.temporary.name)/'timer.cpp'
        harness = HARNESS.replace('ISCC_TV_', 'ISCC_ADDON_TV_') if 'PREFIX="ISCC_ADDON_TV_"' in source else HARNESS
        file.write_text(harness.replace('@@PRODUCTION@@', production))
        cls.binary = str(file.with_suffix(''))
        result = subprocess.run([shutil.which('c++'), '-std=c++17', str(file), '-o', cls.binary], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)

    def scenario(self, name):
        result = subprocess.run([self.binary, name], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_symbol_never_opens_charts_on_repeated_updates(self): self.scenario('missing')
    def test_existing_charts_receive_levels_without_duplicates(self): self.scenario('existing')
    def test_closed_chart_stays_closed_and_manual_reopening_resumes_drawing(self): self.scenario('reopen')
    def test_deletion_preserves_manual_objects(self): self.scenario('delete')
    def test_failed_drawing_does_not_open_replacement_chart(self): self.scenario('failed-draw')
    def test_unchanged_levels_have_no_writes_or_forced_redraws(self): self.scenario('steady')
    def test_redraws_are_batched_per_changed_chart(self): self.scenario('batch')
    def test_deleted_or_edited_owned_objects_are_repaired(self): self.scenario('repair')
    def test_read_failure_is_pending_and_recovers_without_cached_ack(self): self.scenario('read-error')


if __name__ == '__main__':
    unittest.main()
